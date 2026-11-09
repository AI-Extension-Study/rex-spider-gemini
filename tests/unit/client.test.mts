import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REQUEST_TIMEOUT_MS, createClient } from '../../src/client.mts';

interface Call {
  url: string;
  init: RequestInit;
}

function answering(response: () => Response, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  };
}

test('a GET carries the browser cookies and answers ok with any status and the body', async () => {
  const calls: Call[] = [];
  const client = createClient({ fetch: answering(() => new Response('<html>', { status: 500 }), calls) });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'ok', status: 500, text: '<html>' });
  assert.equal(calls[0].url, 'https://gemini.google.com/app');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
});

test('a form POST sends the body as a form, with the browser cookies', async () => {
  const calls: Call[] = [];
  const client = createClient({ fetch: answering(() => new Response(")]}'", { status: 200 }), calls) });
  const body = new URLSearchParams({ 'f.req': '[]', at: 'TOKEN' });
  assert.deepEqual(await client.postForm('https://gemini.google.com/batch', body), { kind: 'ok', status: 200, text: ")]}'" });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(calls[0].init.body, body);
});

test('a request with no answer within the timeout is aborted and answers timeout', { timeout: 2000 }, async () => {
  let signal: AbortSignal | null = null;
  const client = createClient({
    timeoutMs: 20,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal ?? null;
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'timeout' });
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('a fetch that ignores the abort still ends at the timeout', { timeout: 2000 }, async () => {
  const client = createClient({ timeoutMs: 20, fetch: () => new Promise(() => {}) });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'timeout' });
});

test('a body that never finishes is cut at the same timeout', { timeout: 2000 }, async () => {
  const client = createClient({ timeoutMs: 20, fetch: answering(() => new Response(new ReadableStream({ start() {} }))) });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'timeout' });
});

test('a fetch that rejects answers network', async () => {
  const client = createClient({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'network' });
});

test('requests time out after 20 s unless told otherwise', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 20_000);
});

test('a client made without a timeout aborts at 20 s, not before', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createClient({ fetch: () => new Promise(() => {}) });
  let settled = false;
  const answer = client.get('https://gemini.google.com/app').then((value) => {
    settled = true;
    return value;
  });
  t.mock.timers.tick(19_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'ended before 20 s');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'still waiting at 20 s');
  assert.deepEqual(await answer, { kind: 'timeout' });
});

test('a request that answered leaves no timer behind to abort its signal later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null = null;
  const client = createClient({
    fetch: async (_url, init) => {
      signal = init.signal ?? null;
      return new Response('ok');
    },
  });
  assert.deepEqual(await client.get('https://gemini.google.com/app'), { kind: 'ok', status: 200, text: 'ok' });
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  assert.equal((signal as AbortSignal | null)?.aborted, false, 'a timer aborted a request that had already answered');
});
