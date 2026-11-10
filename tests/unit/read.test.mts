import assert from 'node:assert/strict';
import { test } from 'node:test';

import { READ_COUNT, parseRead, readArgs } from '../../src/read.mts';
import { batchResponse, chatId, wrb } from './batch.mts';
import { MARKER, citationSlot, draftId, exchange, readResponse, responseId, toolSlot } from './exchanges.mts';

const CHAT = chatId(1);
// The counts of the builder's default prompt and reply, 'MARKER-do-not-keep
// prompt' and 'MARKER-do-not-keep reply', with no citations or tool calls.
const PLAIN = { prompt: { chars: 25, words: 2 }, reply: { text: { chars: 24, words: 2 }, citations: 0, searchResults: 0 } };

test('a read asks for 200 exchanges of one chat, in the form the web app uses', () => {
  assert.equal(READ_COUNT, 200);
  assert.deepEqual(readArgs(CHAT), [CHAT, 200, null, 1, [0], [4], null, 1]);
});

test('a read gives each exchange\'s response id, parent, time, drafts and attachment kinds, in the order sent', () => {
  const body = readResponse([
    exchange({ chat: CHAT, response: 3, parent: 2, seconds: 1700000300, drafts: 2, mimes: ['image/png'] }),
    exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 }),
    exchange({ chat: CHAT, response: 1, seconds: 1700000100 }),
  ]);
  assert.deepEqual(parseRead(body, CHAT), {
    kind: 'read',
    whole: true,
    skipped: 0,
    exchanges: [
      { responseId: responseId(3), parentDraftId: draftId(20), shownDraftId: draftId(30), whenSec: 1700000300, whenNanos: 457522000, drafts: 2, attachmentTypes: ['image/png'], ...PLAIN },
      { responseId: responseId(2), parentDraftId: draftId(10), shownDraftId: draftId(20), whenSec: 1700000200, whenNanos: 457522000, drafts: 1, attachmentTypes: [], ...PLAIN },
      { responseId: responseId(1), parentDraftId: null, shownDraftId: draftId(10), whenSec: 1700000100, whenNanos: 457522000, drafts: 1, attachmentTypes: [], ...PLAIN },
    ],
  });
});

test('a read with a cursor in payload[1] was cut and is not whole', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100 })], 'MORE'), CHAT);
  assert.equal(result.kind === 'read' ? result.whole : result.kind, false, 'a read that carries a cursor counted as whole');
});

test('an empty-string cursor counts as none: the read is whole', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100 })], ''), CHAT);
  assert.equal(result.kind === 'read' ? result.whole : result.kind, true, 'an empty cursor counted as more to read');
});

test('files are counted from the first file list of the prompt; its twin list is not read', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['image/png'] });
  const holder = ((ex[2] as unknown[])[0] as unknown[])[4] as unknown[][];
  const twin = exchange({ chat: CHAT, response: 9, seconds: 1, mimes: ['application/pdf', 'application/pdf'] });
  holder[0][4] = ((((twin[2] as unknown[])[0] as unknown[])[4] as unknown[][])[0])[3];
  const result = parseRead(readResponse([ex]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result, ['image/png']);
});

test('a reply without a drafts list has an unknown draft count, not zero', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  (ex[3] as unknown[])[0] = null;
  const result = parseRead(readResponse([ex]), CHAT);
  assert.equal(result.kind === 'read' ? result.exchanges[0].drafts : result.kind, null);
});

test('an exchange without a response id of r_ form or a numeric time is skipped and counted', () => {
  const good = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  const noId = exchange({ chat: CHAT, response: 2, seconds: 1700000200 });
  (noId[0] as unknown[])[1] = 'not-an-id';
  const noTime = exchange({ chat: CHAT, response: 3, seconds: 1700000300 });
  noTime[4] = ['1700000300', 0];
  const result = parseRead(readResponse([noTime, noId, good]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges.map((e) => e.responseId), result.skipped] : result, [[responseId(1)], 2]);
});

test('a parent draft that is not of rc_ form reads as no parent', () => {
  for (const value of ['MARKER-do-not-keep', responseId(1), 7]) {
    const odd = exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 });
    (odd[1] as unknown[])[2] = value;
    const result = parseRead(readResponse([odd]), CHAT);
    assert.equal(result.kind === 'read' ? result.exchanges[0].parentDraftId : result.kind, null, String(value));
  }
});

test('a read counts the prompt and the shown draft\'s reply, never another draft\'s', () => {
  const body = readResponse([exchange({
    chat: CHAT, response: 1, seconds: 1700000100, drafts: 3, shown: 2,
    prompt: 'T1 What are the headlines?', reply: 'Headlines, with sources.', citations: citationSlot(7), tools: toolSlot([9, null]),
  })]);
  const result = parseRead(body, CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges[0].shownDraftId, result.exchanges[0].prompt, result.exchanges[0].reply] : result, [
    draftId(12),
    { chars: 26, words: 5 },
    { text: { chars: 24, words: 3 }, citations: 7, searchResults: 9 },
  ]);
});

test('placeholder links are left out of the reply\'s counts', () => {
  const reply = 'Three cafes nearby. http://googleusercontent.com/map_content/0 http://googleusercontent.com/map_content/1';
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, reply })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].reply.text : result, { chars: 21, words: 3 });
});

test('thinking is not counted as reply text', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, reply: 'Twenty-five.', tools: toolSlot([], 'Let me count the primes below one hundred, one at a time.') })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].reply : result, { text: { chars: 12, words: 1 }, citations: 0, searchResults: 0 });
});

test('with no draft of the shown id, every reply count is null and drafts still counts', () => {
  for (const shown of [draftId(99), 'MARKER-do-not-keep', null]) {
    const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, drafts: 2 });
    (ex[3] as unknown[])[3] = shown;
    const result = parseRead(readResponse([ex]), CHAT);
    assert.deepEqual(result.kind === 'read' ? [result.exchanges[0].reply, result.exchanges[0].drafts] : result, [{ text: null, citations: null, searchResults: null }, 2], String(shown));
  }
});

test('a shown draft id of another length still finds its draft, and is reported as null', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, reply: 'Two words.', citations: citationSlot(2) });
  const longer = `rc_${'ab'.repeat(10)}`;
  (((ex[3] as unknown[])[0] as unknown[][])[0])[0] = longer;
  (ex[3] as unknown[])[3] = longer;
  const result = parseRead(readResponse([ex]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges[0].shownDraftId, result.exchanges[0].reply] : result, [
    null, { text: { chars: 10, words: 2 }, citations: 2, searchResults: 0 },
  ]);
});

test('the shown draft id is kept only in rc_ form', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  (ex[3] as unknown[])[3] = 'MARKER-do-not-keep';
  const result = parseRead(readResponse([ex]), CHAT);
  assert.equal(result.kind === 'read' ? result.exchanges[0].shownDraftId : result.kind, null);
});

test('a prompt that is not a string has null counts, and an empty prompt counts 0', () => {
  const counts = (prompt: unknown) => {
    const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, prompt })]), CHAT);
    return result.kind === 'read' ? result.exchanges[0].prompt : result;
  };
  assert.equal(counts(null), null);
  assert.equal(counts(['T1 in a list']), null);
  assert.deepEqual(counts(''), { chars: 0, words: 0 });
});

test('a reply text that is not a string has null text counts, and its lists are still counted', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, reply: null, citations: citationSlot(2), tools: toolSlot([3]) })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].reply : result, { text: null, citations: 2, searchResults: 3 });
});

test('no prompt, reply, thought, passage, source or result text reaches a parsed read', () => {
  const body = readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, drafts: 2, citations: citationSlot(2), tools: toolSlot([3, null], `${MARKER} thoughts`) })]);
  assert.ok(body.includes(`${MARKER} thoughts`) && body.includes(`${MARKER} passage`), 'Test setup invalid: the fixture holds no marked text');
  const result = parseRead(body, CHAT);
  assert.equal(result.kind, 'read', 'Test setup invalid: the read did not parse');
  assert.ok(!JSON.stringify(result).includes(MARKER), 'text from the read reached the parsed exchange');
});

test('an attachment type outside the closed set, or none, reads as other', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['application/x-secret-name', 'image/jpeg', ''] })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result, ['other', 'image/jpeg', 'other']);
});

test('a read of a chat that does not exist is an error with its status code', () => {
  // The answer a real read of a made-up chat id got, with the message string replaced.
  const body = `)]}'\n\n200\n[["wrb.fr","hNvQHb",null,null,null,[5,null,[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1167,null,"x"]]]],"generic"]]\n`;
  assert.deepEqual(parseRead(body, CHAT), { kind: 'error', code: 5 });
});

test('a body without the batchexecute guard or without an hNvQHb frame is not a read', () => {
  assert.deepEqual(parseRead('<!doctype html><title>Sign in</title>', CHAT), { kind: 'not-a-read' });
  assert.deepEqual(parseRead(batchResponse(wrb('MaZiqc', [null, null, []])), CHAT), { kind: 'not-a-read' });
});

test('a payload whose exchange slot is not an array is an error, not a chat with no exchanges', () => {
  for (const payload of [null, 'x', [null, null], [{}, null]]) {
    assert.deepEqual(parseRead(batchResponse(wrb('hNvQHb', payload)), CHAT), { kind: 'error', code: null }, JSON.stringify(payload));
  }
});

test('a read that skipped an exchange is not whole, since the oldest exchange may be the one missing', () => {
  const oldest = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  oldest[4] = ['1700000100', 0];
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 }), oldest]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.whole, result.skipped] : result, [false, 1]);
});

test('a read with no readable exchange is an error, not an empty chat', () => {
  const unreadable = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  unreadable[4] = null;
  for (const exchanges of [[], [unreadable]]) {
    assert.deepEqual(parseRead(readResponse(exchanges), CHAT), { kind: 'error', code: null }, `${exchanges.length} exchanges`);
  }
});

test('an exchange time outside 2001 to 2286, such as one in milliseconds, is skipped', () => {
  for (const seconds of [1.7e12, 1e13, 5e8]) {
    const result = parseRead(readResponse([exchange({ chat: CHAT, response: 2, seconds }), exchange({ chat: CHAT, response: 1, seconds: 1700000100 })]), CHAT);
    assert.deepEqual(result.kind === 'read' ? [result.exchanges.map((e) => e.responseId), result.skipped] : result, [[responseId(1)], 1], String(seconds));
  }
});

test('a response id seen twice is kept once and the repeat counted', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100 }), exchange({ chat: CHAT, response: 1, seconds: 1700000100 })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges.length, result.skipped] : result, [1, 1]);
});

test('an exchange of another chat is skipped', () => {
  const result = parseRead(readResponse([exchange({ chat: chatId(2), response: 2, seconds: 1700000200 }), exchange({ chat: CHAT, response: 1, seconds: 1700000100 })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges.map((e) => e.responseId), result.skipped] : result, [[responseId(1)], 1]);
});

test('a file entry without a type string counts as other', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['image/png'] });
  const files = (((ex[2] as unknown[])[0] as unknown[])[4] as unknown[][])[0][3] as unknown[];
  files.push([null, 1, 'name.png']);
  const result = parseRead(readResponse([ex]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result, ['image/png', 'other']);
});

test('a prompt has no files when a level of the file path is null or absent, as text-only prompts show', () => {
  const block = (ex: unknown[]) => (ex[2] as unknown[])[0] as unknown[];
  const cases: [string, (ex: unknown[]) => void][] = [
    ['a null file list', () => {}],
    ['an empty holder, as the capture showed', (ex) => { block(ex)[4] = [[]]; }],
    ['no holder at all, the text alone, as 2 of 10 captured chats had', (ex) => { (ex[2] as unknown[])[0] = [block(ex)[0]]; }],
    ['a null holder list', (ex) => { block(ex)[4] = null; }],
    ['an empty holder list', (ex) => { block(ex)[4] = []; }],
    ['a null holder', (ex) => { block(ex)[4] = [null]; }],
  ];
  for (const [what, change] of cases) {
    const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
    change(ex);
    const result = parseRead(readResponse([ex]), CHAT);
    assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result.kind, [], what);
  }
});

test('a file list of another form, or one holding something other than lists, is unknown, not no files', () => {
  const block = (ex: unknown[]) => (ex[2] as unknown[])[0] as unknown[];
  const cases: [string, (ex: unknown[]) => void][] = [
    ['an entry that is null', (ex) => (((block(ex)[4] as unknown[][])[0][3]) as unknown[]).push(null)],
    ['an entry that is a string', (ex) => (((block(ex)[4] as unknown[][])[0][3]) as unknown[]).push('stray')],
    ['a list that is a string', (ex) => { (block(ex)[4] as unknown[][])[0][3] = 'x'; }],
    ['a holder that is a string', (ex) => { (block(ex)[4] as unknown[])[0] = 'x'; }],
    ['a holder of holders that is an object', (ex) => { block(ex)[4] = {}; }],
    ['a prompt block that is not a list', (ex) => { (ex[2] as unknown[])[0] = 'x'; }],
    ['no prompt block', (ex) => { ex[2] = null; }],
  ];
  for (const [what, change] of cases) {
    const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['image/png'] });
    change(ex);
    const result = parseRead(readResponse([ex]), CHAT);
    assert.equal(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result.kind, null, what);
  }
});

test('a reply made only of placeholder links counts 0, not null', () => {
  const reply = 'http://googleusercontent.com/map_content/0http://googleusercontent.com/map_content/1';
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, reply })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].reply.text : result, { chars: 0, words: 0 });
});

test('a missing, negative, oversized or fractional nanosecond value reads as 0', () => {
  for (const time of [[1700000100], [1700000100, -1], [1700000100, 1e9], [1700000100, 1.5]]) {
    const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
    ex[4] = time;
    const result = parseRead(readResponse([ex]), CHAT);
    assert.equal(result.kind === 'read' ? result.exchanges[0].whenNanos : result.kind, 0, JSON.stringify(time));
  }
});

test('1e9 is the first plausible second and 1e10 the first that is not', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 2, seconds: 1e10 }), exchange({ chat: CHAT, response: 1, seconds: 1e9 })]), CHAT);
  assert.deepEqual(result.kind === 'read' ? [result.exchanges.map((e) => e.responseId), result.skipped] : result, [[responseId(1)], 1]);
});
