import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ListItem } from '../../src/list.mts';
import { parseRead } from '../../src/read.mts';
import { buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { chatId, listEntry } from './batch.mts';
import { MARKER, exchange, readResponse, responseId } from './exchanges.mts';

const CHAT = chatId(1);
const entry = listEntry(1, 1700000300);
const item: ListItem = { id: CHAT, endedSec: 1700000300, entry };

function read(body: string) {
  const result = parseRead(body, CHAT);
  if (result.kind !== 'read') throw new Error(`Test setup invalid: the fixture did not parse as a read (${result.kind})`);
  return result;
}

const threeExchanges = readResponse([
  exchange({ chat: CHAT, response: 3, parent: 2, seconds: 1700000300, drafts: 2, mimes: ['image/png'] }),
  exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 }),
  exchange({ chat: CHAT, response: 1, seconds: 1700000100 }),
]);

test('the summary record is the record the spider sent before, plus is_summary true', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildSummaryRecord(item))), {
    name: 'rex-conversation',
    is_summary: true,
    date: 1700000300000,
    identifier: CHAT,
    turns: [],
    platform: 'gemini',
    ended: '2023-11-14T22:18:20Z',
    metadata: entry,
  });
});

test('the detail record keeps the summary\'s metadata and ended, and adds started and the exchanges oldest first', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildDetailRecord(item, read(threeExchanges)))), {
    name: 'rex-conversation',
    is_summary: false,
    date: 1700000100000,
    identifier: CHAT,
    turns: [
      { identifier: responseId(1), parent: null, when: '2023-11-14T22:15:00.457522Z', drafts: 1, attachments: 0, attachment_types: [] },
      { identifier: responseId(2), parent: responseId(1), when: '2023-11-14T22:16:40.457522Z', drafts: 1, attachments: 0, attachment_types: [] },
      { identifier: responseId(3), parent: responseId(2), when: '2023-11-14T22:18:20.457522Z', drafts: 2, attachments: 1, attachment_types: ['image/png'] },
    ],
    platform: 'gemini',
    ended: '2023-11-14T22:18:20Z',
    started: '2023-11-14T22:15:00Z',
    metadata: entry,
  });
});

test('no prompt or reply text, file name, URL, token or account constant from the read reaches the detail record', () => {
  const body = threeExchanges;
  assert.ok(body.includes(MARKER), 'Test setup invalid: the fixture carries no marker, so its absence below would mean nothing');
  const record = JSON.stringify(buildDetailRecord(item, read(body)));
  assert.ok(!record.includes(MARKER), record);
});

test('a read that was cut gives no started, and the record is dated by its last message', () => {
  const cut = read(readResponse([exchange({ chat: CHAT, response: 3, parent: 2, seconds: 1700000300 })], 'MORE'));
  const record = JSON.parse(JSON.stringify(buildDetailRecord(item, cut)));
  assert.equal('started' in record, false, 'a cut read gave a start time it cannot know');
  assert.equal(record.date, 1700000300000);
  assert.equal(record.turns.length, 1);
});

test('both records give rex-spider the same last-message time, so their upload keys use one time', () => {
  const summary = buildSummaryRecord(item);
  const detail = buildDetailRecord(item, read(threeExchanges));
  assert.equal(Math.round(summary.ended.timestamp()), 1700000300000);
  assert.equal(Math.round(detail.ended.timestamp()), 1700000300000);
});

test('a whole read with no exchanges gives no started and is dated by its last message', () => {
  // parseRead calls such a read an error; the builder is safe with one anyway.
  const record = JSON.parse(JSON.stringify(buildDetailRecord(item, { kind: 'read', exchanges: [], whole: true, skipped: 0 })));
  assert.equal('started' in record, false, 'a read with no exchanges gave a start time');
  assert.deepEqual([record.date, record.turns], [1700000300000, []]);
});

test('a read that skipped an exchange gives no started', () => {
  const oldest = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  oldest[4] = ['1700000100', 0];
  const record = JSON.parse(JSON.stringify(buildDetailRecord(item, read(readResponse([exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 }), oldest])))));
  assert.equal('started' in record, false, 'a read missing an exchange gave a start time');
});

test('exchanges in one second are ordered by nanoseconds, and on a full tie a reply follows its prompt', () => {
  // Sent oldest first here, so only the nanoseconds can put them in order.
  const byNanos = read(readResponse([
    exchange({ chat: CHAT, response: 1, seconds: 1700000100, nanos: 100000000 }),
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000100, nanos: 900000000 }),
  ]));
  assert.deepEqual(buildDetailRecord(item, byNanos).turns.map((turn) => turn.identifier), [responseId(1), responseId(2)]);
  const tie = read(readResponse([
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000100, nanos: 0 }),
    exchange({ chat: CHAT, response: 1, seconds: 1700000100, nanos: 0 }),
  ]));
  assert.deepEqual(buildDetailRecord(item, tie).turns.map((turn) => turn.identifier), [responseId(1), responseId(2)]);
});

test('a one-exchange chat starts at the same whole second it ends, never after', () => {
  const one = read(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000300, nanos: 457522000 })]));
  const record = buildDetailRecord(item, one);
  assert.ok(record.started !== undefined, 'Test setup invalid: a whole one-exchange read gave no started');
  assert.ok(record.started.timestamp() <= record.ended.timestamp(), `started ${record.started.toJSON()} is after ended ${record.ended.toJSON()}`);
  assert.equal(record.date, 1700000300000);
});

test('when keeps a nanosecond value below 0.1 s exactly', () => {
  const tiny = read(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, nanos: 5000 })]));
  assert.equal(buildDetailRecord(item, tiny).turns[0].when, '2023-11-14T22:15:00.000005Z');
});

test('a start after the listed end is left out, and the record is dated by its last message', () => {
  // The chat changed between the list call and its read: its oldest exchange is newer than the time the list gave.
  const record = buildDetailRecord(item, read(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000305 })])));
  assert.deepEqual(['started' in record, record.date], [false, 1700000300 * 1000]);
});

test('a start in the same second as the listed end is kept', () => {
  const record = buildDetailRecord(item, read(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000300, nanos: 900000000 })])));
  assert.equal(record.started?.timestamp(), 1700000300 * 1000);
});
