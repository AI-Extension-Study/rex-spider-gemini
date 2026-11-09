import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoKey } from '../../src/keys.mts';
import { type HandleMessage, createStore } from '../../src/store.mts';

type Message = { messageType: string; key: string; value?: unknown };

// A double of rex-core's store with its two behaviours that matter here: a
// missing key answers null, and while its database is not open a read is not
// handled at all (false, no answer) and a write is taken (true) but never
// answered.
function rexCore({ open = true }: { open?: boolean } = {}) {
  const values = new Map<string, unknown>();
  const handleMessage = ((message: Message, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (message.messageType === 'fetchValue') {
      if (!open) return false;
      queueMicrotask(() => sendResponse(values.has(message.key) ? values.get(message.key) : null));
      return true;
    }
    if (message.messageType === 'storeValue') {
      if (open) {
        values.set(message.key, message.value);
        queueMicrotask(() => sendResponse(true));
      }
      return true;
    }
    return false;
  }) as unknown as HandleMessage;
  return { values, handleMessage };
}

const quiet = () => {};

test('a read answers what was stored, and null for a key never stored', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  assert.deepEqual(await store.set('k', { a: 1 }), { ok: true, unanswered: false });
  assert.deepEqual(await store.get('k'), { value: { a: 1 }, unanswered: false });
  assert.deepEqual(await store.get('never'), { value: null, unanswered: false });
});

test('while rex-core\'s database is not open a read is unanswered at once and a write after the deadline', { timeout: 2000 }, async () => {
  const store = createStore(rexCore({ open: false }).handleMessage, { deadlineMs: 50, log: quiet });
  const started = performance.now();
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  assert.ok(performance.now() - started < 40, 'the read waited for a deadline no answer could beat');
  assert.deepEqual(await store.set('k', 1), { ok: false, unanswered: true });
});

test('a read that gets no answer within the deadline counts as absent and is flagged', { timeout: 2000 }, async () => {
  const silent = (() => true) as unknown as HandleMessage;
  const store = createStore(silent, { deadlineMs: 20, log: quiet });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
});

test('an answer that comes after the deadline is ignored', { timeout: 2000 }, async () => {
  let late: ((response: unknown) => void) | null = null;
  const slow = ((_message: Message, _sender: unknown, sendResponse: (response: unknown) => void) => {
    late = sendResponse;
    return true;
  }) as unknown as HandleMessage;
  const lines: string[] = [];
  const store = createStore(slow, { deadlineMs: 20, log: (line) => lines.push(line) });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  (late as unknown as (response: unknown) => void)('too late');
  assert.ok(lines.some((line) => line.includes('late answer')), 'the late answer was not logged');
});

test('a handleMessage that throws leaves the read and the write unanswered', async () => {
  const broken = (() => {
    throw new Error('boom');
  }) as unknown as HandleMessage;
  const store = createStore(broken, { log: quiet });
  assert.deepEqual(await store.get('k'), { value: null, unanswered: true });
  assert.deepEqual(await store.set('k', 1), { ok: false, unanswered: true });
});

test('the mode record reads back as written, and anything else stored there reads as absent and malformed', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  assert.deepEqual(await store.mode.get(), { value: null, unanswered: false, malformed: false });
  await store.mode.set({ mode: 'detail', since: 1700000000000 });
  assert.deepEqual(await store.mode.get(), { value: { mode: 'detail', since: 1700000000000 }, unanswered: false, malformed: false });
  for (const bad of [{ mode: 'other', since: 1 }, { mode: 'summary', since: -1 }, { mode: 'summary', since: 1.5 }, { mode: 'summary' }, 'detail', [1]]) {
    core.values.set('rex-spider-gemini-mode', bad);
    assert.deepEqual(await store.mode.get(), { value: null, unanswered: false, malformed: true }, JSON.stringify(bad));
  }
});

test('a detail memo reads back as written, and clearing it writes null', async () => {
  const core = rexCore();
  const store = createStore(core.handleMessage, { log: quiet });
  const memo = { ended: 1700000000000, at: 1700000100000, retryMs: 86_400_000, failures: 1 };
  await store.memo.set('c_0000000000000001', memo);
  assert.deepEqual(await store.memo.get('c_0000000000000001'), { value: memo, unanswered: false, malformed: false });
  await store.memo.clear('c_0000000000000001');
  assert.equal(core.values.get(memoKey('c_0000000000000001')), null);
  assert.deepEqual(await store.memo.get('c_0000000000000001'), { value: null, unanswered: false, malformed: false });
  core.values.set(memoKey('c_0000000000000002'), { ended: 1, at: 1, retryMs: 0, failures: 1 });
  assert.deepEqual(await store.memo.get('c_0000000000000002'), { value: null, unanswered: false, malformed: true });
});

test('log lines name a key\'s kind, never the chat id in it', { timeout: 2000 }, async () => {
  const lines: string[] = [];
  const store = createStore(rexCore({ open: false }).handleMessage, { deadlineMs: 20, log: (line) => lines.push(line) });
  await store.memo.get('c_0000000000000001');
  await store.memo.set('c_0000000000000001', { ended: 1, at: 1, retryMs: 1, failures: 1 });
  assert.ok(lines.length >= 2, 'Test setup invalid: nothing was logged, so the absence below would mean nothing');
  assert.ok(lines.every((line) => !line.includes('c_0000000000000001')), lines.join('\n'));
  assert.ok(lines.every((line) => line.includes('rex-spider-gemini-detail-memo')), lines.join('\n'));
});
