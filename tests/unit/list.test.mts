import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { parseListPage, toConversation } from '../../src/list.mts';
import { batchResponse, chatId, listEntry, wrb, wrbError } from './batch.mts';

test('a page gives each chat id, its last-message seconds and its raw entry, in list order', () => {
  const first = listEntry(1, 1700000000);
  const second = listEntry(2, 1699990000);
  assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', [null, null, [first, second]]))), {
    kind: 'page',
    items: [
      { id: 'c_0000000000000001', endedSec: 1700000000, entry: first },
      { id: 'c_0000000000000002', endedSec: 1699990000, entry: second },
    ],
    next: null,
    skipped: 0,
  });
});

test('the next-page token is payload[1] when it is a non-empty string', () => {
  const withToken = parseListPage(batchResponse(wrb('MaZiqc', [null, 'NEXT-PAGE', [listEntry(1, 1700000000)]])));
  assert.equal(withToken.kind === 'page' ? withToken.next : 'not a page', 'NEXT-PAGE');
  for (const token of ['', 7, null]) {
    const page = parseListPage(batchResponse(wrb('MaZiqc', [null, token, [listEntry(1, 1700000000)]])));
    assert.equal(page.kind === 'page' ? page.next : 'not a page', null, `token ${JSON.stringify(token)}`);
  }
});

test('a token in a payload without the entry slot is not followed', () => {
  assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', [null, 'NEXT-PAGE']))), { kind: 'page', items: [], next: null, skipped: 0 });
});

test('an entry whose time JSON.parse reads as Infinity is skipped and counted', () => {
  // Written into the payload string by hand: JSON.stringify turns Infinity
  // and NaN into null, so only a raw number too large for a double reaches
  // the parser as a non-finite time.
  const payload = `[null,null,[${JSON.stringify(listEntry(1, 1700000000))},["${chatId(2)}","Title",null,null,null,[1e999,0]]]]`;
  const page = parseListPage(batchResponse(['wrb.fr', 'MaZiqc', payload, null, null, null, 'generic']));
  assert.equal(page.kind === 'page' ? `${page.items.map((item) => item.id).join()} skipped ${page.skipped}` : page.kind, 'c_0000000000000001 skipped 1');
});

test('an entry without a string id or a numeric time at [5][0] is skipped and counted', () => {
  const good = listEntry(1, 1700000000);
  const entries = [
    good,
    [null, 'Title', null, null, null, [1700000000, 0]],
    [chatId(3), 'Title', null, null, null, null],
    [chatId(4), 'Title', null, null, null, ['1700000000', 0]],
    'not an entry',
  ];
  assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', [null, null, entries]))), {
    kind: 'page',
    items: [{ id: 'c_0000000000000001', endedSec: 1700000000, entry: good }],
    next: null,
    skipped: 4,
  });
});

test('a payload with no chat array is a page with no items', () => {
  for (const payload of [[], [null, null], [null, null, null], null]) {
    assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', payload))), { kind: 'page', items: [], next: null, skipped: 0 }, JSON.stringify(payload));
  }
});

test('an error frame is reported, not read as an empty page', () => {
  assert.deepEqual(parseListPage(batchResponse(wrbError('MaZiqc', 3))), { kind: 'error', code: 3 });
});

test('a payload that is neither an array nor null is an error, not an empty page', () => {
  assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', 'unexpected'))), { kind: 'error', code: null });
});

test('an entry slot that holds something other than an array or null is an error, not an empty page', () => {
  for (const chats of [{}, 'not-an-array', 3]) {
    assert.deepEqual(parseListPage(batchResponse(wrb('MaZiqc', [null, null, chats]))), { kind: 'error', code: null }, JSON.stringify(chats));
  }
});

test('a list item becomes the record fields the spider sends, with the upload-key inputs earlier builds used', () => {
  const entry = listEntry(1, 1700000000);
  const conversation = toConversation({ id: chatId(1), endedSec: 1700000000, entry });
  assert.ok(conversation.ended instanceof DateString);
  assert.strictEqual(conversation.metadata, entry);
  assert.deepEqual(JSON.parse(JSON.stringify(conversation)), {
    identifier: 'c_0000000000000001', turns: [], platform: 'gemini', ended: '2023-11-14T22:13:20Z', metadata: entry,
  });
  // rex-spider keys an upload as rex-spider-<spider>-conversation-upload-<id>-<Math.round(ended ms)>.
  assert.equal(
    `rex-spider-gemini-conversation-upload-${conversation.identifier}-${Math.round(conversation.ended.timestamp())}`,
    'rex-spider-gemini-conversation-upload-c_0000000000000001-1700000000000',
  );
});

test('a body without the batchexecute guard, or without a MaZiqc frame, is not a list', () => {
  assert.deepEqual(parseListPage('<!doctype html><title>Sign in</title>'), { kind: 'not-a-list' });
  assert.deepEqual(parseListPage(batchResponse(wrb('ESY5D', [1]))), { kind: 'not-a-list' });
});

test('an entry whose time is outside 2001 to 2286, such as one in milliseconds, is skipped and counted', () => {
  for (const seconds of [1.7e12, 5e8]) {
    const page = parseListPage(batchResponse(wrb('MaZiqc', [null, null, [listEntry(1, 1700000000), listEntry(2, seconds)]])));
    assert.deepEqual(page.kind === 'page' ? [page.items.map((item) => item.id), page.skipped] : page, [[chatId(1)], 1], String(seconds));
  }
});

test('an entry whose id is not c_ and lowercase hex is skipped and counted, so no record of it is cut down by the redactor', () => {
  const odd = ['c_0123456789ABCDEF', 'chat one', 'c_', 'r_0000000000000001'].map((id) => [id, 'Title', null, null, null, [1700000000, 0]]);
  const page = parseListPage(batchResponse(wrb('MaZiqc', [null, null, [...odd, listEntry(1, 1700000000)]])));
  assert.deepEqual(page.kind === 'page' ? [page.items.map((listed) => listed.id), page.skipped] : page, [[chatId(1)], 4]);
});
