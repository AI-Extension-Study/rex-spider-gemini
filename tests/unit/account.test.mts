import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT_ARGS, ACCOUNT_RPC, accountDue, accountHash, accountSettings, buildGeminiAccount, isAccountState, parseActivity, shouldSend } from '../../src/account.mts';
import { batchResponse, wrb, wrbError } from './batch.mts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HASH = 'a'.repeat(64);

test('the account read is off unless the served block says enabled true, and the interval is a whole 15 to 1440 minutes or 60', () => {
  for (const block of [undefined, null, {}, [], 'on', { enabled: 'true' }, { enabled: 1 }]) {
    assert.deepEqual(accountSettings(block), { enabled: false, intervalMinutes: 60 }, JSON.stringify(block));
  }
  // An interval with no enabled is still off.
  assert.deepEqual(accountSettings({ interval_minutes: 30 }), { enabled: false, intervalMinutes: 30 });
  assert.deepEqual(accountSettings({ enabled: true }), { enabled: true, intervalMinutes: 60 });
  for (const interval_minutes of [14, 1441, 30.5, '30', null, -60]) {
    assert.deepEqual(accountSettings({ enabled: true, interval_minutes }), { enabled: true, intervalMinutes: 60 }, String(interval_minutes));
  }
  assert.deepEqual(accountSettings({ enabled: true, interval_minutes: 15 }), { enabled: true, intervalMinutes: 15 });
  assert.deepEqual(accountSettings({ enabled: true, interval_minutes: 1440 }), { enabled: true, intervalMinutes: 1440 });
});

test('a read is due with no state, once the interval has passed, and when the stored read is more than 5 minutes in the future', () => {
  const at = (readAt: number) => ({ hash: HASH, sentAt: readAt, readAt });
  assert.equal(accountDue(null, NOW, 60), true);
  assert.equal(accountDue(at(NOW - 59 * MINUTE), NOW, 60), false);
  assert.equal(accountDue(at(NOW - 60 * MINUTE), NOW, 60), true);
  assert.equal(accountDue(at(NOW - 15 * MINUTE), NOW, 15), true);
  // The clock moved back.
  assert.equal(accountDue(at(NOW + 6 * MINUTE), NOW, 60), true);
  assert.equal(accountDue(at(NOW + 5 * MINUTE), NOW, 60), false);
  assert.equal(accountDue(at(NOW + 4 * MINUTE), NOW, 60), false);
});

test('a record is sent when none was sent, when it changed, or a day after the last one', () => {
  assert.equal(shouldSend(null, HASH, NOW), true);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW - 23 * HOUR, readAt: NOW - HOUR }, HASH, NOW), false);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW - 24 * HOUR, readAt: NOW - HOUR }, HASH, NOW), true);
  assert.equal(shouldSend({ hash: 'b'.repeat(64), sentAt: NOW - MINUTE, readAt: NOW - MINUTE }, HASH, NOW), true);
  // The state a read that sent nothing leaves behind.
  assert.equal(shouldSend({ hash: '', sentAt: 0, readAt: NOW - HOUR }, HASH, NOW), true);
  // The clock moved back past the last send.
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 6 * MINUTE, readAt: NOW }, HASH, NOW), true);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 5 * MINUTE, readAt: NOW }, HASH, NOW), false);
  assert.equal(shouldSend({ hash: HASH, sentAt: NOW + 4 * MINUTE, readAt: NOW }, HASH, NOW), false);
});

test('the stored state is a hash (or none yet) and two whole epoch-ms times; anything else is not', () => {
  assert.equal(isAccountState({ hash: HASH, sentAt: NOW, readAt: NOW }), true);
  assert.equal(isAccountState({ hash: '', sentAt: 0, readAt: NOW }), true);
  for (const value of [null, [], 'state', { hash: HASH, sentAt: NOW }, { hash: 'x', sentAt: NOW, readAt: NOW }, { hash: HASH, sentAt: -1, readAt: NOW }, { hash: HASH, sentAt: NOW, readAt: '1' }, { hash: HASH, sentAt: 1.5, readAt: NOW }]) {
    assert.equal(isAccountState(value), false, JSON.stringify(value));
  }
});

test('the ESY5D call is named and argued as the site\'s own call is', () => {
  assert.equal(ACCOUNT_RPC, 'ESY5D');
  assert.equal(JSON.stringify(ACCOUNT_ARGS), '[null,[5]]');
});

test('parseActivity reads Gemini Apps Activity on and off', () => {
  assert.equal(parseActivity(batchResponse(wrb('ESY5D', [[null, null, null, null, true]]))), true);
  assert.equal(parseActivity(batchResponse(wrb('ESY5D', [[null, null, null, null, false]]))), false);
});

test('parseActivity is null for an error frame, a body without the guard, a reshaped payload, or another call\'s frame', () => {
  const expired = `)]}'\n\n90\n[["wrb.fr","ESY5D",null,null,null,[16],"generic",[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096]]]]]\n`;
  const cases: [string, string][] = [
    ['an error frame', batchResponse(wrbError('ESY5D', 3))],
    ['an expired session', expired],
    ['no guard', JSON.stringify([wrb('ESY5D', [[null, null, null, null, true]])])],
    ['an HTML page', '<html>Sign in</html>'],
    ['a string where the flag is', batchResponse(wrb('ESY5D', [[null, null, null, null, 'yes']]))],
    ['a number where the flag is', batchResponse(wrb('ESY5D', [[null, null, null, null, 1]]))],
    ['a slot added', batchResponse(wrb('ESY5D', [[null, null, null, null, true, null]]))],
    ['a value where a null was', batchResponse(wrb('ESY5D', [['x', null, null, null, true]]))],
    ['a payload of another shape', batchResponse(wrb('ESY5D', [null, null, null, null, true]))],
    ['another call\'s frame', batchResponse(wrb('MaZiqc', [[null, null, null, null, true]]))],
    ['two frames', batchResponse(wrb('ESY5D', [[null, null, null, null, true]]), wrb('ESY5D', [[null, null, null, null, false]]))],
  ];
  for (const [what, body] of cases) {
    assert.equal(parseActivity(body), null, what);
  }
});

test('the Gemini record fills history_saved and source_status, and every other standard key is null, in the standard order', () => {
  const record = buildGeminiAccount(200, true, NOW, 1);
  assert.deepEqual(record, {
    name: 'rex-account', platform: 'gemini', format_version: 1, date: NOW,
    plan: null, paid: null, workspace: null, web_search_enabled: null, training_allowed: null,
    history_saved: true, memory_enabled: null, custom_instructions_set: null, account_created: null,
    source_status: { ESY5D: 200 }, metadata: {},
  });
  assert.deepEqual(Object.keys(record), [
    'name', 'platform', 'format_version', 'date',
    'plan', 'paid', 'workspace', 'web_search_enabled', 'training_allowed', 'history_saved', 'memory_enabled', 'custom_instructions_set', 'account_created', 'source_status', 'metadata',
  ]);
  assert.equal(buildGeminiAccount(-1, null, NOW, 1).history_saved, null);
  assert.deepEqual(buildGeminiAccount(-1, null, NOW, 1).source_status, { ESY5D: -1 });
  assert.equal(buildGeminiAccount(200, 'true' as unknown as boolean, NOW, 1).history_saved, null);
});

test('the hash is SHA-256 hex of the record without its date, with keys sorted at every level', async () => {
  const record = buildGeminiAccount(200, true, NOW, 1);
  const hash = await accountHash(record);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await accountHash(buildGeminiAccount(200, true, NOW + HOUR, 1)), hash, 'the date changed the hash');
  assert.notEqual(await accountHash(buildGeminiAccount(200, false, NOW, 1)), hash, 'a change of setting kept the hash');
  const reordered = Object.fromEntries(Object.entries(record).reverse()) as typeof record;
  assert.equal(await accountHash(reordered), hash, 'the key order changed the hash');
  const nested = { ...record, source_status: { b: 1, a: 2 } };
  assert.equal(await accountHash(nested), await accountHash({ ...record, source_status: { a: 2, b: 1 } }), 'nested key order changed the hash');
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update('{"account_created":null,"custom_instructions_set":null,"format_version":1,"history_saved":true,"memory_enabled":null,"metadata":{},"name":"rex-account","paid":null,"plan":null,"platform":"gemini","source_status":{"ESY5D":200},"training_allowed":null,"web_search_enabled":null,"workspace":null}').digest('hex');
  assert.equal(hash, expected);
});

test('the account record carries the data format it is built with, and nothing else changes', () => {
  for (const format of [2, 3]) {
    const record = buildGeminiAccount(200, true, NOW, format);
    assert.equal(record.format_version, format);
    assert.deepEqual(record, { ...buildGeminiAccount(200, true, NOW, 1), format_version: format });
  }
});

test('the hash differs between formats for the same settings, so the first read under a new format sends its record', async () => {
  const one = await accountHash(buildGeminiAccount(200, true, NOW, 1));
  const two = await accountHash(buildGeminiAccount(200, true, NOW, 2));
  assert.notEqual(two, one);
  // The state a format-1 record sent an hour ago leaves: unchanged, it would not be sent again for a day.
  const state = { hash: one, sentAt: NOW - HOUR, readAt: NOW - HOUR };
  assert.deepEqual([shouldSend(state, one, NOW), shouldSend(state, two, NOW)], [false, true]);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update('{"account_created":null,"custom_instructions_set":null,"format_version":2,"history_saved":true,"memory_enabled":null,"metadata":{},"name":"rex-account","paid":null,"plan":null,"platform":"gemini","source_status":{"ESY5D":200},"training_allowed":null,"web_search_enabled":null,"workspace":null}').digest('hex');
  assert.equal(two, expected);
});
