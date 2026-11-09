import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHUNK_MS, sleep } from '../../src/pacing.mts';

function recorder() {
  const events: string[] = [];
  return {
    events,
    keepAlive: () => {
      events.push('keep-alive');
    },
    wait: async (ms: number) => {
      events.push(`wait ${ms}`);
    },
  };
}

test('a 45 s sleep is three waits of at most 20 s, each right after a keep-alive call', async () => {
  const record = recorder();
  await sleep(45_000, { keepAlive: record.keepAlive, wait: record.wait });
  assert.equal(CHUNK_MS, 20_000);
  assert.deepEqual(record.events, ['keep-alive', 'wait 20000', 'keep-alive', 'wait 20000', 'keep-alive', 'wait 5000']);
});

test('the default 30 s crawl delay has no stretch longer than 20 s without a keep-alive call', async () => {
  const record = recorder();
  await sleep(30_000, { keepAlive: record.keepAlive, wait: record.wait });
  assert.deepEqual(record.events, ['keep-alive', 'wait 20000', 'keep-alive', 'wait 10000']);
});

test('a keep-alive that throws or rejects is logged by error name and the sleep goes on', async () => {
  const lines: string[] = [];
  const waits: number[] = [];
  let calls = 0;
  const keepAlive = () => {
    calls += 1;
    if (calls === 1) throw new TypeError('no storage');
    return Promise.reject(new RangeError('quota'));
  };
  await sleep(25_000, { keepAlive, wait: async (ms) => { waits.push(ms); }, log: (line) => lines.push(line) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(waits, [20_000, 5_000]);
  assert.deepEqual(lines.sort(), ['keep-alive failed (RangeError)', 'keep-alive failed (TypeError)']);
});

test('a log that throws while reporting a failed keep-alive does not break the sleep', async () => {
  const waits: number[] = [];
  let calls = 0;
  const keepAlive = () => {
    calls += 1;
    if (calls === 1) throw new TypeError('no storage');
    return Promise.reject(new RangeError('quota'));
  };
  const log = () => {
    throw new Error('log broke');
  };
  await sleep(25_000, { keepAlive, wait: async (ms) => { waits.push(ms); }, log });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(waits, [20_000, 5_000]);
});

test('a keep-alive that never answers does not hold the sleep', { timeout: 2000 }, async () => {
  const record = recorder();
  await sleep(10_000, { keepAlive: () => new Promise(() => {}), wait: record.wait });
  assert.deepEqual(record.events, ['wait 10000']);
});

test('a sleep of zero, a negative or a non-number makes no call', async () => {
  for (const ms of [0, -5, Number.NaN]) {
    const record = recorder();
    await sleep(ms, { keepAlive: record.keepAlive, wait: record.wait });
    assert.deepEqual(record.events, [], String(ms));
  }
});

test('without an injected wait, sleep waits on a real timer', async () => {
  const started = performance.now();
  await sleep(30, { keepAlive: () => undefined });
  assert.ok(performance.now() - started >= 25, 'returned before the timer');
});
