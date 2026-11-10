import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ListItem } from '../../src/list.mts';
import { parseRead } from '../../src/read.mts';
import { buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { chatId, listEntry } from './batch.mts';
import { MARKER, citationSlot, draftId, exchange, readResponse, responseId, toolSlot } from './exchanges.mts';

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

// The standard turns of the builder's default exchange: the prompt
// 'MARKER-do-not-keep prompt' and the reply 'MARKER-do-not-keep reply', with
// no citations or tool calls. A prompt's parent is the draft it followed.
function userTurn(n: number, when: string, parent: string | null, types: string[] = []) {
  return {
    identifier: responseId(n), parent, speaker: 'user', when, on_current_branch: true,
    text_chars: 25, text_words: 2, citation_count: 0, search_result_count: 0, attachments: types.length, attachment_types: types,
  };
}
function assistantTurn(n: number, when: string, drafts = 1) {
  return {
    identifier: draftId(n * 10), parent: responseId(n), speaker: 'assistant', when, on_current_branch: true,
    text_chars: 24, text_words: 2, citation_count: 0, search_result_count: 0, attachments: 0, drafts,
  };
}

test('the summary record is the record the spider sent before, plus is_summary true and the format version', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildSummaryRecord(item))), {
    name: 'rex-conversation',
    is_summary: true,
    format_version: 1,
    date: 1700000300000,
    identifier: CHAT,
    turns: [],
    platform: 'gemini',
    ended: '2023-11-14T22:18:20Z',
    metadata: entry,
  });
});

test('the detail record keeps the summary\'s metadata and ended, and adds started, turns_complete and two turns per exchange, oldest first', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildDetailRecord(item, read(threeExchanges)))), {
    name: 'rex-conversation',
    is_summary: false,
    format_version: 1,
    date: 1700000100000,
    identifier: CHAT,
    turns: [
      userTurn(1, '2023-11-14T22:15:00.457522Z', null),
      assistantTurn(1, '2023-11-14T22:15:00.457522Z'),
      userTurn(2, '2023-11-14T22:16:40.457522Z', draftId(10)),
      assistantTurn(2, '2023-11-14T22:16:40.457522Z'),
      userTurn(3, '2023-11-14T22:18:20.457522Z', draftId(20), ['image/png']),
      assistantTurn(3, '2023-11-14T22:18:20.457522Z', 2),
    ],
    turns_complete: true,
    platform: 'gemini',
    ended: '2023-11-14T22:18:20Z',
    started: '2023-11-14T22:15:00Z',
    metadata: entry,
  });
});

test('a user turn and an assistant turn carry the standard keys in order, then their own extra', () => {
  const [user, assistant] = buildDetailRecord(item, read(threeExchanges)).turns;
  const standard = ['identifier', 'parent', 'speaker', 'when', 'on_current_branch', 'text_chars', 'text_words', 'citation_count', 'search_result_count', 'attachments'];
  assert.deepEqual(Object.keys(user), [...standard, 'attachment_types']);
  assert.deepEqual(Object.keys(assistant), [...standard, 'drafts']);
});

test('the turns carry the counts of the prompt, the shown reply, its citations and its search results', () => {
  const record = buildDetailRecord(item, read(readResponse([exchange({
    chat: CHAT, response: 1, seconds: 1700000100, drafts: 2, shown: 1,
    prompt: 'T1 What are the headlines?', reply: 'Headlines, with sources.', citations: citationSlot(7), tools: toolSlot([9, null]),
  })])));
  const [user, assistant] = JSON.parse(JSON.stringify(record.turns));
  assert.deepEqual([user.text_chars, user.text_words, user.citation_count, user.search_result_count], [26, 5, 0, 0]);
  assert.deepEqual(
    [assistant.identifier, assistant.text_chars, assistant.text_words, assistant.citation_count, assistant.search_result_count, assistant.drafts],
    [draftId(11), 24, 3, 7, 9, 2],
  );
});

test('a prompt whose file list is unknown has null attachments and null kinds', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['image/png'] });
  ((ex[2] as unknown[])[0] as unknown[])[4] = 'not a holder';
  const [user] = buildDetailRecord(item, read(readResponse([ex]))).turns;
  assert.deepEqual([user.attachments, user.speaker === 'user' ? user.attachment_types : 'not a user turn'], [null, null]);
});

test('a reply with no draft of the shown id keeps that id and has null counts; a shown id of another form is null', () => {
  const missing = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  (missing[3] as unknown[])[3] = draftId(99);
  const odd = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  (odd[3] as unknown[])[3] = MARKER;
  for (const [ex, id] of [[missing, draftId(99)], [odd, null]] as const) {
    const assistant = buildDetailRecord(item, read(readResponse([ex]))).turns[1];
    assert.deepEqual(
      [assistant.identifier, assistant.text_chars, assistant.text_words, assistant.citation_count, assistant.search_result_count, assistant.attachments],
      [id, null, null, null, null, 0],
    );
  }
});

test('no prompt or reply text, file name, URL, token or account constant from the read reaches the detail record', () => {
  const body = readResponse([
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200, drafts: 2, mimes: ['image/png'], citations: citationSlot(2), tools: toolSlot([3, null], `${MARKER} thoughts`) }),
    exchange({ chat: CHAT, response: 1, seconds: 1700000100 }),
  ]);
  assert.ok(body.includes(MARKER), 'Test setup invalid: the fixture carries no marker, so its absence below would mean nothing');
  const record = JSON.stringify(buildDetailRecord(item, read(body)));
  assert.ok(!record.includes(MARKER), record);
});

test('a read that was cut gives no started, and the record is dated by its last message', () => {
  const cut = read(readResponse([exchange({ chat: CHAT, response: 3, parent: 2, seconds: 1700000300 })], 'MORE'));
  const record = JSON.parse(JSON.stringify(buildDetailRecord(item, cut)));
  assert.equal('started' in record, false, 'a cut read gave a start time it cannot know');
  assert.equal(record.date, 1700000300000);
  assert.deepEqual([record.turns.length, record.turns_complete], [2, false]);
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
  assert.equal(record.turns_complete, false, 'a read missing an exchange counted as complete');
});

test('exchanges in one second are ordered by nanoseconds, and on a full tie a reply follows its prompt', () => {
  // Sent oldest first here, so only the nanoseconds can put them in order.
  const byNanos = read(readResponse([
    exchange({ chat: CHAT, response: 1, seconds: 1700000100, nanos: 100000000 }),
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000100, nanos: 900000000 }),
  ]));
  const inOrder = [responseId(1), draftId(10), responseId(2), draftId(20)];
  assert.deepEqual(buildDetailRecord(item, byNanos).turns.map((turn) => turn.identifier), inOrder);
  const tie = read(readResponse([
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000100, nanos: 0 }),
    exchange({ chat: CHAT, response: 1, seconds: 1700000100, nanos: 0 }),
  ]));
  assert.deepEqual(buildDetailRecord(item, tie).turns.map((turn) => turn.identifier), inOrder);
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
  const [user, assistant] = buildDetailRecord(item, tiny).turns;
  assert.deepEqual([user.when, assistant.when], ['2023-11-14T22:15:00.000005Z', '2023-11-14T22:15:00.000005Z']);
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
