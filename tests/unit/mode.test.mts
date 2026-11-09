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
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1-detail', ended])), true);
});

test('a chat never sent at this time is sent', async () => {
  const ended = SWITCH - 10 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended - 1000])), false);
});

test('a chat sent in the other mode and last used within 90 days before the switch is sent again', async () => {
  for (const daysBefore of [0, 2, 81, 90]) {
    const ended = SWITCH - daysBefore * DAY;
    assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended])), false, `${daysBefore} days before`);
  }
});

test('a chat sent in the other mode and last used more than 90 days before the switch keeps its record', async () => {
  const ended = SWITCH - 90 * DAY - 1000;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', SWITCH, keys(['c_1', ended])), true);
});

test('the rule runs both ways: back to summary, a detail-mode chat from the last 90 days is sent as a summary', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'summary', SWITCH, keys(['c_1-detail', ended])), false);
  assert.equal(await sentAlready('c_1', at(ended), 'summary', SWITCH, keys(['c_1', ended])), true);
});

test('with no start this pass, a chat sent in the other mode is held back, not sent', async () => {
  const ended = SWITCH - 3 * DAY;
  assert.equal(await sentAlready('c_1', at(ended), 'detail', null, keys(['c_1', ended])), true);
  assert.equal(await sentAlready('c_1', at(ended), 'detail', null, keys()), false);
});

test('the update itself: a browser with only summary keys, served detail, re-sends exactly the last 90 days', async () => {
  const fake = modeStore(read(null));
  const since = await resendSince(fake.store, 'detail', SWITCH);
  const chats: [string, number][] = [['c_nov18', SWITCH - 2 * DAY], ['c_sep1', SWITCH - 80 * DAY], ['c_jul1', SWITCH - 142 * DAY]];
  const held = keys(...chats);
  const resent = [];
  for (const [id, ended] of chats) {
    if (!(await sentAlready(id, at(ended), 'detail', since, held))) resent.push(id);
  }
  assert.deepEqual(resent, ['c_nov18', 'c_sep1']);
});
