import assert from 'node:assert/strict';
import { test } from 'node:test';

import { READ_COUNT, parseRead, readArgs } from '../../src/read.mts';
import { batchResponse, chatId, wrb } from './batch.mts';
import { exchange, readResponse, responseId } from './exchanges.mts';

const CHAT = chatId(1);

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
  assert.deepEqual(parseRead(body), {
    kind: 'read',
    whole: true,
    skipped: 0,
    exchanges: [
      { responseId: responseId(3), parentId: responseId(2), whenSec: 1700000300, drafts: 2, attachmentTypes: ['image/png'] },
      { responseId: responseId(2), parentId: responseId(1), whenSec: 1700000200, drafts: 1, attachmentTypes: [] },
      { responseId: responseId(1), parentId: null, whenSec: 1700000100, drafts: 1, attachmentTypes: [] },
    ],
  });
});

test('a read with a cursor in payload[1] was cut and is not whole', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100 })], 'MORE'));
  assert.equal(result.kind === 'read' ? result.whole : result.kind, false, 'a read that carries a cursor counted as whole');
});

test('an empty-string cursor counts as none: the read is whole', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100 })], ''));
  assert.equal(result.kind === 'read' ? result.whole : result.kind, true, 'an empty cursor counted as more to read');
});

test('files are counted from the first file list of the prompt; its twin list is not read', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['image/png'] });
  const holder = ((ex[2] as unknown[])[0] as unknown[])[4] as unknown[][];
  const twin = exchange({ chat: CHAT, response: 9, seconds: 1, mimes: ['application/pdf', 'application/pdf'] });
  holder[0][4] = ((((twin[2] as unknown[])[0] as unknown[])[4] as unknown[][])[0])[3];
  const result = parseRead(readResponse([ex]));
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result, ['image/png']);
});

test('a reply without a drafts list counts no drafts', () => {
  const ex = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  (ex[3] as unknown[])[0] = null;
  const result = parseRead(readResponse([ex]));
  assert.equal(result.kind === 'read' ? result.exchanges[0].drafts : result.kind, 0);
});

test('an exchange without a response id of r_ form or a numeric time is skipped and counted', () => {
  const good = exchange({ chat: CHAT, response: 1, seconds: 1700000100 });
  const noId = exchange({ chat: CHAT, response: 2, seconds: 1700000200 });
  (noId[0] as unknown[])[1] = 'not-an-id';
  const noTime = exchange({ chat: CHAT, response: 3, seconds: 1700000300 });
  noTime[4] = ['1700000300', 0];
  const result = parseRead(readResponse([noTime, noId, good]));
  assert.deepEqual(result.kind === 'read' ? [result.exchanges.map((e) => e.responseId), result.skipped] : result, [[responseId(1)], 2]);
});

test('a parent that is not of r_ form reads as no parent', () => {
  const odd = exchange({ chat: CHAT, response: 2, parent: 1, seconds: 1700000200 });
  (odd[1] as unknown[])[1] = 'MARKER-do-not-keep';
  const result = parseRead(readResponse([odd]));
  assert.equal(result.kind === 'read' ? result.exchanges[0].parentId : result.kind, null);
});

test('an attachment type outside the closed set, or none, reads as other', () => {
  const result = parseRead(readResponse([exchange({ chat: CHAT, response: 1, seconds: 1700000100, mimes: ['application/x-secret-name', 'image/jpeg', ''] })]));
  assert.deepEqual(result.kind === 'read' ? result.exchanges[0].attachmentTypes : result, ['other', 'image/jpeg', 'other']);
});

test('a read of a chat that does not exist is an error with its status code', () => {
  // The answer a real read of a made-up chat id got, with the message string replaced.
  const body = `)]}'\n\n200\n[["wrb.fr","hNvQHb",null,null,null,[5,null,[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1167,null,"x"]]]],"generic"]]\n`;
  assert.deepEqual(parseRead(body), { kind: 'error', code: 5 });
});

test('a body without the batchexecute guard or without an hNvQHb frame is not a read', () => {
  assert.deepEqual(parseRead('<!doctype html><title>Sign in</title>'), { kind: 'not-a-read' });
  assert.deepEqual(parseRead(batchResponse(wrb('MaZiqc', [null, null, []]))), { kind: 'not-a-read' });
});

test('a payload whose exchange slot is not an array is an error, not a chat with no exchanges', () => {
  for (const payload of [null, 'x', [null, null], [{}, null]]) {
    assert.deepEqual(parseRead(batchResponse(wrb('hNvQHb', payload))), { kind: 'error', code: null }, JSON.stringify(payload));
  }
});
