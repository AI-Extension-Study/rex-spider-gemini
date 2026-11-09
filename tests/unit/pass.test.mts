import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type PassFramework, runPass } from '../../src/pass.mts';
import { type GeminiRecord } from '../../src/record.mts';
import { batchResponse, chatId, listEntry, wrb, wrbError } from './batch.mts';

const HOMEPAGE: Answer = { kind: 'ok', status: 200, text: '<script>WIZ_global_data = {"SNlM0e":"PAGE-TOKEN:1"};</script>' };
const listPage = (entries: unknown[][], next: string | null = null): Answer => ({ kind: 'ok', status: 200, text: batchResponse(wrb('MaZiqc', [null, next, entries])) });
const EMPTY = listPage([]);

// The spider's two list calls answered by variant: [1,null,1] first, then the
// main list [0,null,1], each a single page unless a cursor is scripted.
function client({ home = HOMEPAGE, other = EMPTY, main = EMPTY, more = {} as Record<string, Answer> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    get: async (url: string): Promise<Answer> => {
      calls.push(`GET ${url}`);
      return home;
    },
    postForm: async (url: string, body: URLSearchParams): Promise<Answer> => {
      const args = JSON.parse(JSON.parse(body.get('f.req') ?? '')[0][0][1]) as unknown[];
      calls.push(`list ${JSON.stringify(args[2])} ${String(args[1])} at=${body.get('at')} ${url.slice(url.indexOf('_reqid='))}`);
      if (args[1] !== null) return more[String(args[1])];
      return JSON.stringify(args[2]) === '[0,null,1]' ? main : other;
    },
  };
}

// rex-spider's side as the pass sees it: the crawl window, and the upload keys
// a browser holds, keyed as rex-spider keys them (id and ended in ms).
function framework({ windowStart = 0, held = [] as [string, number][], silentReads = false, silentStamps = false } = {}) {
  const keys = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  const stamped: string[] = [];
  const events: string[] = [];
  const counts = { reads: 0, stampTries: 0 };
  const fw: PassFramework = {
    crawlWindowContains: async (ms) => ms >= windowStart,
    checkIfAlreadyTransmitted: (id: string, ended: DateString) => {
      counts.reads += 1;
      return silentReads ? new Promise(() => {}) : Promise.resolve(keys.has(`${id} ${Math.round(ended.timestamp())}`));
    },
    logTransmitted: (id: string, ended: DateString) => {
      counts.stampTries += 1;
      if (silentStamps) return new Promise(() => {});
      stamped.push(`${id} ${Math.round(ended.timestamp())}`);
      events.push(`stamp ${id}`);
      return Promise.resolve();
    },
    fetchCrawlDelay: () => 30_000,
  };
  return { fw, stamped, events, counts };
}

async function pass(fake: ReturnType<typeof client>, side: ReturnType<typeof framework>, limits = {}) {
  const sent: GeminiRecord[] = [];
  const waits: number[] = [];
  let keepAlives = 0;
  const outcome = await runPass({
    client: fake,
    framework: side.fw,
    dispatch: (record) => {
      sent.push(record);
      side.events.push(`dispatch ${record.identifier}`);
    },
    sleep: async (ms) => {
      waits.push(ms);
      side.events.push(`wait ${ms}`);
    },
    keepAlive: () => {
      keepAlives += 1;
    },
    requestId: 123456,
    limits: { settleMs: 1500, batch: 25, storeMs: 20, ...limits },
    log: () => {},
  });
  return { outcome, sent, waits, keepAlives };
}

const T = 1700000000;
const entries = (n: number) => Array.from({ length: n }, (_, i) => listEntry(i + 1, T + i));

test('a complete pass sends a summary record for each unsent chat in the window, newest first, and says Fetch successful.', async () => {
  const run = await pass(client({ main: listPage(entries(3)) }), framework());
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(3), true], [chatId(2), true], [chatId(1), true]]);
  assert.deepEqual(run.outcome, { crawledCount: 3, crawledIds: [chatId(1), chatId(2), chatId(3)], reason: 'Fetch successful.', issue: null });
});

test('after an update, chats the old build sent, keyed by the bare chat id, are not sent again', async () => {
  const side = framework({ held: [[chatId(1), T * 1000], [chatId(2), (T + 1) * 1000]] });
  const run = await pass(client({ main: listPage(entries(3)) }), side);
  assert.deepEqual(run.sent.map((record) => record.identifier), [chatId(3)]);
  assert.deepEqual(side.stamped, [`${chatId(3)} ${(T + 2) * 1000}`]);
});

test('keys are stamped only after the settle wait that follows each batch of records', async () => {
  const side = framework();
  await pass(client({ main: listPage(entries(3)) }), side, { batch: 2 });
  // The first wait is the walk's crawl_delay between its two list calls.
  assert.deepEqual(side.events, [
    'wait 30000',
    `dispatch ${chatId(3)}`, `dispatch ${chatId(2)}`, 'wait 1500', `stamp ${chatId(3)}`, `stamp ${chatId(2)}`,
    `dispatch ${chatId(1)}`, 'wait 1500', `stamp ${chatId(1)}`,
  ]);
});

test('a chat outside the crawl window is neither listed as crawled nor sent', async () => {
  const run = await pass(client({ main: listPage(entries(3)) }), framework({ windowStart: (T + 1) * 1000 }));
  assert.deepEqual([run.outcome.crawledIds, run.sent.map((record) => record.identifier)], [[chatId(2), chatId(3)], [chatId(3), chatId(2)]]);
});

test('each homepage failure ends the pass before any list call, with its own reason', async () => {
  const cases: [Answer, string, string][] = [
    [{ kind: 'timeout' }, 'Error encountered fetching network resource: timeout.', 'Error encountered fetching network resource: timeout.'],
    [{ kind: 'network' }, 'Error encountered fetching network resource: network.', 'Error encountered fetching network resource: network.'],
    [{ kind: 'ok', status: 503, text: '' }, 'Homepage fetch failed (status 503).', 'Unable to fetch https://gemini.google.com/app. Status code = 503.'],
    [{ kind: 'ok', status: 404, text: '' }, 'Homepage fetch failed (status 404).', 'Unable to fetch https://gemini.google.com/app. Status code = 404.'],
    [{ kind: 'ok', status: 200, text: '<html>Sign in</html>' }, 'No access token found on homepage.', 'No access token found on homepage.'],
  ];
  for (const [home, reason, issue] of cases) {
    const fake = client({ home, main: listPage(entries(1)) });
    const run = await pass(fake, framework());
    assert.deepEqual(run.outcome, { crawledCount: -1, crawledIds: [], reason, issue }, reason);
    assert.deepEqual(fake.calls, ['GET https://gemini.google.com/app'], `${reason}: a list call was made`);
  }
});

test('the list calls carry this pass\'s page token and request id, and a later pass reads a new token', async () => {
  const first = client({ main: listPage(entries(1)) });
  await pass(first, framework());
  assert.ok(first.calls.slice(1).every((call) => call.endsWith('at=PAGE-TOKEN:1 _reqid=123456')), first.calls.join('\n'));
  const second = client({ home: { kind: 'ok', status: 200, text: '{"SNlM0e":"PAGE-TOKEN:2"}' }, main: listPage(entries(1)) });
  await pass(second, framework());
  assert.ok(second.calls.slice(1).every((call) => call.includes('at=PAGE-TOKEN:2 ')), second.calls.join('\n'));
});

test('a list answer that is not a list, or a list call that fails, ends the pass with an error and sends nothing', async () => {
  const cases: [Answer, string][] = [
    [{ kind: 'ok', status: 200, text: '<html></html>' }, 'Error encountered parsing conversations: Received invalid response for conversation API.'],
    [{ kind: 'timeout' }, 'Error encountered parsing conversations: Unable to crawl the conversation list (timeout).'],
    [{ kind: 'network' }, 'Error encountered parsing conversations: Unable to crawl the conversation list (network).'],
    [{ kind: 'ok', status: 500, text: '' }, 'Error encountered parsing conversations: List fetch failed (status 500).'],
  ];
  for (const [answer, reason] of cases) {
    // Chats listed before the failure lie outside the window only for the
    // HTTP error, whose outcome depends on whether any was in it.
    const http = answer.kind === 'ok' && answer.status === 500;
    const side = framework({ windowStart: http ? Number.MAX_SAFE_INTEGER : 0 });
    const run = await pass(client({ other: listPage(entries(1)), main: answer }), side);
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.sent.length, run.outcome.crawledIds], [-1, reason, 0, []], reason);
    if (!http) assert.equal(side.counts.reads, 0, `${reason}: chats were checked after the list failed`);
  }
});

test('an HTTP error after chats in the window were listed, or an expired session, sends them and reports partial', async () => {
  const expired: Answer = { kind: 'ok', status: 200, text: `)]}'\n\n90\n[["wrb.fr","MaZiqc",null,null,null,[16],"generic",[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096]]]]]\n` };
  for (const answer of [{ kind: 'ok', status: 500, text: '' } as Answer, expired]) {
    const run = await pass(client({ other: listPage(entries(2)), main: answer }), framework());
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.outcome.issue], [2, 'Full fetch unsuccessful. Partial results returned.', null]);
  }
});

test('a list error frame sends what was listed and reports partial', async () => {
  const run = await pass(client({ other: { kind: 'ok', status: 200, text: batchResponse(wrbError('MaZiqc', 3)) }, main: listPage(entries(2)) }), framework());
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [2, 'Full fetch unsuccessful. Partial results returned.']);
});

test('a key read that gets no answer ends the pass with an error before anything is sent', { timeout: 2000 }, async () => {
  const run = await pass(client({ main: listPage(entries(3)) }), framework({ silentReads: true }));
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.sent.length], [-1, 'Error encountered parsing conversations: the store did not answer.', 0]);
});

test('a stamp that gets no answer stops the stamping, and the pass reports partial', { timeout: 2000 }, async () => {
  const side = framework({ silentStamps: true });
  const run = await pass(client({ main: listPage(entries(3)) }), side);
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, side.counts.stampTries], [3, 'Full fetch unsuccessful. Partial results returned.', 1]);
});

test('a long check of the listed chats makes a keep-alive call every 100 chats', async () => {
  const run = await pass(client({ main: listPage(entries(250)) }), framework({ held: entries(250).map((entry, i) => [String(entry[0]), (T + i) * 1000]) }));
  assert.equal(run.keepAlives, 2);
  assert.equal(run.sent.length, 0);
});

test('a dispatch that throws is logged, its key is not stamped, and the pass goes on', async () => {
  const side = framework();
  let first = true;
  const outcome = await runPass({
    client: client({ main: listPage(entries(2)) }),
    framework: side.fw,
    dispatch: () => {
      if (first) {
        first = false;
        throw new Error('queue full');
      }
    },
    sleep: async () => {},
    keepAlive: () => {},
    requestId: 1,
    limits: { settleMs: 1500, batch: 25, storeMs: 20 },
    log: () => {},
  });
  assert.deepEqual([outcome.crawledCount, side.stamped.length], [1, 1]);
});

test('a pass never throws: a framework call that throws ends it with an error reason naming only the error\'s kind', async () => {
  const side = framework();
  side.fw.crawlWindowContains = async () => {
    throw new TypeError('secret detail');
  };
  const run = await pass(client({ main: listPage(entries(1)) }), side);
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [-1, 'Error encountered parsing conversations: internal error (TypeError).']);
});
