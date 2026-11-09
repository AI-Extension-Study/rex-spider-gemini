import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MODE_KEY, keyKind, memoKey, uploadKeyId } from '../../src/keys.mts';

test('summary mode keeps the bare chat id, the key earlier builds wrote; detail mode adds -detail', () => {
  assert.equal(uploadKeyId('c_0000000000000001', true), 'c_0000000000000001');
  assert.equal(uploadKeyId('c_0000000000000001', false), 'c_0000000000000001-detail');
});

test('the upload key rex-spider builds from it differs between the modes for one chat at one time', () => {
  // rex-spider's key: rex-spider-<spider>-conversation-upload-<id>-<Math.round(ended ms)>.
  const key = (summary: boolean) => `rex-spider-gemini-conversation-upload-${uploadKeyId('c_0000000000000001', summary)}-1700000000000`;
  assert.equal(key(true), 'rex-spider-gemini-conversation-upload-c_0000000000000001-1700000000000');
  assert.equal(key(false), 'rex-spider-gemini-conversation-upload-c_0000000000000001-detail-1700000000000');
});

test('the mode record and the memos sit under the spider\'s namespace', () => {
  assert.equal(MODE_KEY, 'rex-spider-gemini-mode');
  assert.equal(memoKey('c_0000000000000001'), 'rex-spider-gemini-detail-memo-c_0000000000000001');
});

test('a memo key needs a chat id', () => {
  assert.throws(() => memoKey(''), TypeError);
  assert.throws(() => uploadKeyId('', true), TypeError);
});

test('what may be logged of a key is its kind, never a chat id', () => {
  assert.equal(keyKind(MODE_KEY), 'rex-spider-gemini-mode');
  assert.equal(keyKind(memoKey('c_0000000000000001')), 'rex-spider-gemini-detail-memo');
  assert.equal(keyKind('rex-spider-gemini-conversation-upload-c_0000000000000001-1700000000000'), 'other key');
});
