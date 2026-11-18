import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { RESEND_WINDOW_MS, resendSince, sentAlready } from '../../src/mode.mts';
import { type ModeRecord, type Read, type Write } from '../../src/store.mts';

const DAY = 24 * 60 * 60 * 1000;
const SWITCH = Date.UTC(2026, 10, 20);

function modeStore(stored: Read<ModeRecord>, write: Write = { ok: true, unanswered: false }) {
  const writes: ModeRecord[] = [];
  return {
    writes,
    store: {
      mode: {
        get: async () => stored,
        set: async (record: ModeRecord) => {
          writes.push(record);
          return write;
        },
      },
    },
  };
}

const read = (value: ModeRecord | null, flags: Partial<Read<ModeRecord>> = {}): Read<ModeRecord> => ({ value, unanswered: false, malformed: false, ...flags });

test('the re-send window is 90 days', () => {
  assert.equal(RESEND_WINDOW_MS, 7_776_000_000);
});

test('with no record, as on the first pass after an update, the served mode starts now', async () => {
  const fake = modeStore(read(null));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
});

test('a record of the served mode keeps its start and is not written again', async () => {
  const fake = modeStore(read({ mode: 'detail', since: SWITCH - 5 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH - 5 * DAY);
  assert.deepEqual(fake.writes, []);
});

test('a record of the other mode, or a malformed one, is replaced by the served mode from now', async () => {
  for (const stored of [read({ mode: 'summary', since: SWITCH - 50 * DAY }), read(null, { malformed: true })]) {
    const fake = modeStore(stored);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
    assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  }
});

test('a start more than a day ahead of now, written under a clock that ran fast, is replaced by now', async () => {
  const fake = modeStore(read({ mode: 'detail', since: SWITCH + 365 * DAY }));
  assert.equal(await resendSince(fake.store, 'detail', SWITCH), SWITCH);
  assert.deepEqual(fake.writes, [{ mode: 'detail', since: SWITCH }]);
  const close = modeStore(read({ mode: 'detail', since: SWITCH + DAY }));
  assert.equal(await resendSince(close.store, 'detail', SWITCH), SWITCH + DAY);
  assert.deepEqual(close.writes, []);
});

test('a record that could not be read, or a new one that could not be written, gives no start this pass', async () => {
  const unread = modeStore(read(null, { unanswered: true }));
  assert.equal(await resendSince(unread.store, 'detail', SWITCH), null);
  assert.deepEqual(unread.writes, []);
  for (const failed of [{ ok: false, unanswered: true }, { ok: false, unanswered: false }]) {
    const fake = modeStore(read({ mode: 'summary', since: 1 }), failed);
    assert.equal(await resendSince(fake.store, 'detail', SWITCH), null, JSON.stringify(failed));
  }
});

// The upload keys a browser holds, as rex-spider's checkIfAlreadyTransmitted sees them.
function keys(...held: [string, number][]) {
  const set = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  return async (id: string, ended: DateString) => set.has(`${id} ${Math.round(ended.timestamp())}`);
}

const at = (ms: number) => new DateString(ms / 1000);

test('a chat sent in the served mode at this time needs nothing', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1-detail', ended]), 1), true);
});

test('a chat holding keys in both modes at this time, as every re-sent chat does, needs nothing', async () => {
  const ended = SWITCH - 3 * DAY;
  const both = keys(['c_1', ended], ['c_1-detail', ended]);
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready('c_1', at(ended), served, SWITCH, both, 1), true, served);
  }
});

test('a chat never sent at this time is sent', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended - 1000]), 1), false);
});

test('a chat with no key in either mode is sent, however long before the switch it was last used', async () => {
  const ended = SWITCH - 120 * DAY;
  for (const served of ['detail', 'summary'] as const) {
    assert.equal(await sentAlready('c_1', at(ended), served, SWITCH, keys(), 1), false, served);
  }
});

test('a chat sent in the other mode and last used within 90 days before the switch is sent again', async () => {
  for (const daysBefore of [0, 2, 81, 90]) {
    const ended = SWITCH - daysBefore * DAY;
    assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended]), 1), false, `${daysBefore} days before`);
  }
});

test('a chat sent in the other mode and last used more than 90 days before the switch keeps its record', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended]), 1), true);
});

test('the rule runs both ways: back to summary, a detail-mode chat from the last 90 days is sent as a summary', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'summary', SWITCH, keys(['c_1-detail', ended]), 1), false);
  assert.equal(await sentAlready('c_1', at(ended), 'summary', SWITCH, keys(['c_1', ended]), 1), true);
});

test('back to summary, a chat whose detail record is from more than 90 days before the switch keeps it', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready('c_1', at(ended), 'summary', SWITCH, keys(['c_1-detail', ended]), 1), true);
});

test('with no start this pass, a chat sent in the other mode is held back, not sent', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', null, keys(['c_1', ended]), 1), true);
  assert.equal(await sentAlready('c_1', at(ended), 'detail', null, keys(), 1), false);
});

test('the update itself: a browser with only summary keys, served detail, re-sends exactly the last 90 days', async () => {
  const fake = modeStore(read(null));
  const since = await resendSince(fake.store, 'detail', SWITCH);
  const chats: [string, number][] = [['c_nov18', SWITCH - 2 * DAY], ['c_sep1', SWITCH - 80 * DAY], ['c_jul1', SWITCH - 142 * DAY]];
  const held = keys(...chats);
  const resent = [];
  for (const [id, ended] of chats) {
    if (!(await sentAlready(id, at(ended), 'detail', since, held, 1))) resent.push(id);
  }
  assert.deepEqual(resent, ['c_nov18', 'c_sep1']);
});

// A change of data format: the keys of the old format count for nothing, in
// either mode, so every chat in the crawl window goes out once more.
const FORMAT_1_BOTH = (ended: number) => keys(['c_1', ended], ['c_1-detail', ended]);

test('under format 2, a chat holding only format-1 keys, in both modes, is sent, however long before the mode\'s start it was last used', async () => {
  for (const daysBefore of [0, 2, 81, 90, 91, 120, 365, 2000]) {
    const ended = SWITCH - daysBefore * DAY;
    for (const served of ['detail', 'summary'] as const) {
      assert.equal(await sentAlready('c_1', at(ended), served, SWITCH, FORMAT_1_BOTH(ended), 2), false, `${served}, ${daysBefore} days before`);
    }
  }
});

test('under format 2, a format-1 key of the other mode does not count either, even with no start this pass', async () => {
  const ended = SWITCH - 200 * DAY;
  for (const [served, held] of [['detail', 'c_1'], ['summary', 'c_1-detail']] as const) {
    assert.equal(await sentAlready('c_1', at(ended), served, SWITCH, keys([held, ended]), 2), false, served);
    assert.equal(await sentAlready('c_1', at(ended), served, null, keys([held, ended]), 2), false, `${served}, no start`);
  }
});

test('a browser served detail before and after, its mode start long past: format 2 sends every chat in the window', async () => {
  // The mode record says detail since 300 days ago, so under format 1 the
  // chats it sent as summaries before that, 100 and more days old, would keep
  // their summaries.
  const fake = modeStore(read({ mode: 'detail', since: SWITCH - 300 * DAY }));
  const since = await resendSince(fake.store, 'detail', SWITCH);
  assert.equal(since, SWITCH - 300 * DAY, 'Test setup invalid: the stored start was not kept');
  const chats: [string, number][] = [['c_new', SWITCH - DAY], ['c_mid', SWITCH - 100 * DAY], ['c_old', SWITCH - 500 * DAY]];
  const held = keys(...chats.flatMap(([id, ended]): [string, number][] => [[id, ended], [`${id}-detail`, ended]]));
  const due = async (format: number) => {
    const out = [];
    for (const [id, ended] of chats) {
      if (!(await sentAlready(id, at(ended), 'detail', since, held, format))) out.push(id);
    }
    return out;
  };
  assert.deepEqual(await due(1), []);
  assert.deepEqual(await due(2), ['c_new', 'c_mid', 'c_old']);
});

test('within format 2, the keys of format 2 decide, by the same rule as format 1', async () => {
  const recent = SWITCH - 3 * DAY;
  const old = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready('c_1', at(recent), 'detail', SWITCH, keys(['c_1-detail-f2', recent]), 2), true, 'sent in the served mode');
  assert.equal(await sentAlready('c_1', at(recent), 'detail', SWITCH, keys(['c_1-f2', recent]), 2), false, 'the other mode, recent');
  assert.equal(await sentAlready('c_1', at(old), 'detail', SWITCH, keys(['c_1-f2', old]), 2), true, 'the other mode, before the window');
  assert.equal(await sentAlready('c_1', at(old), 'summary', SWITCH, keys(['c_1-detail-f2', old]), 2), true, 'back to summary, before the window');
  assert.equal(await sentAlready('c_1', at(recent), 'summary', null, keys(['c_1-detail-f2', recent]), 2), true, 'no start this pass');
});
