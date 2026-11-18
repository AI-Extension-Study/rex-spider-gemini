import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT_KEY, MODE_KEY, keyKind, memoKey, uploadKeyId } from '../../src/keys.mts';

test('summary mode keeps the bare chat id, the key earlier builds wrote; detail mode adds -detail', () => {
  assert.equal(uploadKeyId('c_0000000000000001', true, 1), 'c_0000000000000001');
  assert.equal(uploadKeyId('c_0000000000000001', false, 1), 'c_0000000000000001-detail');
});

test('a data format above 1 adds -f and the format to the id of either mode; format 1 adds nothing', () => {
  assert.equal(uploadKeyId('c_0000000000000001', true, 2), 'c_0000000000000001-f2');
  assert.equal(uploadKeyId('c_0000000000000001', false, 2), 'c_0000000000000001-detail-f2');
  assert.equal(uploadKeyId('c_0000000000000001', true, 999), 'c_0000000000000001-f999');
  assert.equal(uploadKeyId('c_0000000000000001', false, 10), 'c_0000000000000001-detail-f10');
});

test('the upload key rex-spider builds from it differs between the modes for one chat at one time', () => {
  // rex-spider's key: rex-spider-<spider>-conversation-upload-<id>-<Math.round(ended ms)>.
  const key = (summary: boolean, format = 1) => `rex-spider-gemini-conversation-upload-${uploadKeyId('c_0000000000000001', summary, format)}-1700000000000`;
  assert.equal(key(true), 'rex-spider-gemini-conversation-upload-c_0000000000000001-1700000000000');
  assert.equal(key(false), 'rex-spider-gemini-conversation-upload-c_0000000000000001-detail-1700000000000');
  assert.equal(key(true, 2), 'rex-spider-gemini-conversation-upload-c_0000000000000001-f2-1700000000000');
  assert.equal(key(false, 2), 'rex-spider-gemini-conversation-upload-c_0000000000000001-detail-f2-1700000000000');
});

test('the four ids of one chat, two modes in two formats, are all different', () => {
  const ids = [true, false].flatMap((summary) => [1, 2].map((format) => uploadKeyId('c_0000000000000001', summary, format)));
  assert.equal(new Set(ids).size, 4, ids.join(' '));
});

test('a format that is not a whole number from 1 to 999 is refused, never written into a key', () => {
  for (const format of [0, -1, 1.5, 1000, NaN, '2', null, undefined]) {
    assert.throws(() => uploadKeyId('c_0000000000000001', true, format as unknown as number), TypeError, String(format));
  }
});

test('the mode record, the account state and the memos sit under the spider\'s namespace', () => {
  assert.equal(MODE_KEY, 'rex-spider-gemini-mode');
  assert.equal(ACCOUNT_KEY, 'rex-spider-gemini-account');
  assert.equal(memoKey('c_0000000000000001'), 'rex-spider-gemini-detail-memo-c_0000000000000001');
});

test('a memo key needs a chat id', () => {
  assert.throws(() => memoKey(''), TypeError);
  assert.throws(() => uploadKeyId('', true, 1), TypeError);
});

test('what may be logged of a key is its kind, never a chat id', () => {
  assert.equal(keyKind(MODE_KEY), 'rex-spider-gemini-mode');
  assert.equal(keyKind(ACCOUNT_KEY), 'rex-spider-gemini-account');
  assert.equal(keyKind(memoKey('c_0000000000000001')), 'rex-spider-gemini-detail-memo');
  assert.equal(keyKind('rex-spider-gemini-conversation-upload-c_0000000000000001-1700000000000'), 'other key');
});

test('a chat id that is not a string is refused at run time too', () => {
  assert.throws(() => memoKey(123 as unknown as string), TypeError);
  assert.throws(() => uploadKeyId(null as unknown as string, false, 1), TypeError);
});
