import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type PassFramework, runPass } from '../../src/pass.mts';
import { type GeminiRecord } from '../../src/record.mts';
import { type ModeRecord } from '../../src/store.mts';
import { batchResponse, chatId, listEntry, wrb, wrbError } from './batch.mts';
import { exchange, readResponse } from './exchanges.mts';

const HOMEPAGE: Answer = { kind: 'ok', status: 200, text: '<script>WIZ_global_data = {"SNlM0e":"PAGE-TOKEN:1"};</script>' };
const listPage = (entries: unknown[][], next: string | null = null): Answer => ({ kind: 'ok', status: 200, text: batchResponse(wrb('MaZiqc', [null, next, entries])) });
const EMPTY = listPage([]);
// A list call answered with the BardErrorInfo an expired session gets.
const EXPIRED: Answer = { kind: 'ok', status: 200, text: `)]}'\n\n90\n[["wrb.fr","MaZiqc",null,null,null,[16],"generic",[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096]]]]]\n` };
const ERROR_FRAME: Answer = { kind: 'ok', status: 200, text: batchResponse(wrbError('MaZiqc', 3)) };
// A chat read answered with the BardErrorInfo an expired session gets.
const EXPIRED_READ: Answer = { kind: 'ok', status: 200, text: `)]}'\n\n90\n[["wrb.fr","hNvQHb",null,null,null,[16],"generic",[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096]]]]]\n` };
// What a chat read answers unless a test scripts otherwise: one exchange, a
// minute before the list's times.
const readOf = (id: string): Answer => ({ kind: 'ok', status: 200, text: readResponse([exchange({ chat: id, response: 1, seconds: T - 60 })]) });
const LIMITS = { settleMs: 1500, batch: 25, storeMs: 20, detailBudgetMs: 360_000 };

// The spider's two list calls answered by variant: [1,null,1] first, then the
// main list [0,null,1], each a single page unless a cursor is scripted. A
// chat read gets its scripted answer, or one exchange.
function client({ home = HOMEPAGE, other = EMPTY, main = EMPTY, more = {} as Record<string, Answer>, reads = {} as Record<string, Answer> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    get: async (url: string): Promise<Answer> => {
      calls.push(`GET ${url}`);
      return home;
    },
    postForm: async (url: string, body: URLSearchParams): Promise<Answer> => {
      const [rpcid, json] = JSON.parse(body.get('f.req') ?? '')[0][0] as [string, string];
      const args = JSON.parse(json) as unknown[];
      const reqid = url.slice(url.indexOf('_reqid='));
      if (rpcid === 'hNvQHb') {
        const id = String(args[0]);
        calls.push(`read ${id} ${json} rpcids=${new URL(url).searchParams.get('rpcids')} at=${body.get('at')} ${reqid}`);
        return reads[id] ?? readOf(id);
      }
      calls.push(`list ${JSON.stringify(args[2])} ${String(args[1])} at=${body.get('at')} ${reqid}`);
      if (args[1] !== null) return more[String(args[1])];
      return JSON.stringify(args[2]) === '[0,null,1]' ? main : other;
    },
  };
}

// rex-spider's side as the pass sees it: the served mode, the crawl window,
// and the upload keys a browser holds, keyed as rex-spider keys them (id and
// ended in ms). A stamp adds its key, so a later pass on the same side sees
// it. Summary mode unless a test serves detail.
function framework({ windowStart = 0, held = [] as [string, number][], silentReads = false, silentStamps = false, enabled = (): boolean => true, summarize = true as boolean | (() => boolean), crawlDelay = 30_000 as unknown } = {}) {
  const keys = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  const stamped: string[] = [];
  const events: string[] = [];
  const counts = { windows: 0, reads: 0, stampTries: 0 };
  const fw: PassFramework = {
    isEnabled: enabled,
    justSummarize: () => (typeof summarize === 'function' ? summarize() : summarize),
    crawlWindowContains: async (ms) => {
      counts.windows += 1;
      return ms >= windowStart;
    },
    checkIfAlreadyTransmitted: (id: string, ended: DateString) => {
      counts.reads += 1;
      return silentReads ? new Promise(() => {}) : Promise.resolve(keys.has(`${id} ${Math.round(ended.timestamp())}`));
    },
    logTransmitted: (id: string, ended: DateString) => {
      counts.stampTries += 1;
      if (silentStamps) return new Promise(() => {});
      const key = `${id} ${Math.round(ended.timestamp())}`;
      keys.add(key);
      stamped.push(key);
      events.push(`stamp ${id}`);
      return Promise.resolve();
    },
    fetchCrawlDelay: () => crawlDelay as number,
  };
  return { fw, stamped, events, counts };
}

// The mode record as rex-core's store holds it (store.mts), or a store that
// does not answer.
function modes({ stored = null as ModeRecord | null, unanswered = false } = {}) {
  let value = stored;
  const writes: ModeRecord[] = [];
  const counts = { gets: 0, sets: 0 };
  return {
    writes,
    counts,
    mode: {
      get: async () => {
        counts.gets += 1;
        return { value: unanswered ? null : value, unanswered, malformed: false };
      },
      set: async (record: ModeRecord) => {
        counts.sets += 1;
        writes.push(record);
        value = record;
        return { ok: true, unanswered: false };
      },
    },
  };
}

// One pass with the fakes. The clock starts at now and moves only with the
// waits, so a test can spend the detail budget.
async function pass(fake: ReturnType<typeof client>, side: ReturnType<typeof framework>, limits = {}, { store = modes(), now = NOW, throwOn = null as string | null } = {}) {
  const sent: GeminiRecord[] = [];
  const waits: number[] = [];
  let keepAlives = 0;
  let clock = now;
  const outcome = await runPass({
    client: {
      get: fake.get,
      postForm: (url, body) => {
        const [rpcid, json] = JSON.parse(body.get('f.req') ?? '')[0][0] as [string, string];
        if (rpcid === 'hNvQHb') side.events.push(`read ${String((JSON.parse(json) as unknown[])[0])}`);
        return fake.postForm(url, body);
      },
    },
    framework: side.fw,
    store,
    now: () => clock,
    dispatch: (record) => {
      if (record.identifier === throwOn) throw new Error('queue full');
      sent.push(record);
      side.events.push(`dispatch ${record.identifier}`);
    },
    sleep: async (ms) => {
      waits.push(ms);
      side.events.push(`wait ${ms}`);
      clock += Number(ms) || 0;
    },
    keepAlive: () => {
      keepAlives += 1;
    },
    requestId: 123456,
    limits: { ...LIMITS, ...limits },
    log: () => {},
  });
  return { outcome, sent, waits, keepAlives };
}

const T = 1700000000;
// The clock when a pass starts: an hour after the list's times.
const NOW = (T + 3600) * 1000;
const DAY = 24 * 60 * 60 * 1000;
// A last-message time in seconds, ms before NOW.
const ago = (ms: number) => Math.floor((NOW - ms) / 1000);
const entries = (n: number) => Array.from({ length: n }, (_, i) => listEntry(i + 1, T + i));

test('a complete pass sends a summary record for each unsent chat in the window, newest first, and says Fetch successful.', async () => {
  // Listed in an order that is neither newest nor oldest first.
  const listed = [listEntry(1, T + 1), listEntry(3, T + 3), listEntry(2, T + 2)];
  const run = await pass(client({ main: listPage(listed) }), framework());
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(3), true], [chatId(2), true], [chatId(1), true]]);
  assert.deepEqual(run.outcome, { crawledCount: 3, crawledIds: [chatId(1), chatId(3), chatId(2)], reason: 'Fetch successful.', issue: null });
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
  for (const answer of [{ kind: 'ok', status: 500, text: '' } as Answer, EXPIRED]) {
    const run = await pass(client({ other: listPage(entries(2)), main: answer }), framework());
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.outcome.issue], [2, 'Full fetch unsuccessful. Partial results returned.', null]);
  }
});

test('a list error frame sends what was listed and reports partial', async () => {
  const run = await pass(client({ other: ERROR_FRAME, main: listPage(entries(2)) }), framework());
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [2, 'Full fetch unsuccessful. Partial results returned.']);
});

// A count of 0 or more says crawledIds is a reading of the chats in the
// window; from a list read only in part, an empty one would look like an
// emptied account.
test('an expired session before any chat in the window was listed reports no reading', async () => {
  const reason = 'Error encountered parsing conversations: Session expired.';
  for (const [what, fake, side] of [
    ['at the first list call', client({ other: EXPIRED, main: listPage(entries(2)) }), framework()],
    ['after chats outside the window', client({ other: listPage(entries(2)), main: EXPIRED }), framework({ windowStart: Number.MAX_SAFE_INTEGER })],
  ] as const) {
    const run = await pass(fake, side);
    assert.deepEqual(run.outcome, { crawledCount: -1, crawledIds: [], reason, issue: reason }, what);
  }
});

test('a list read only in part that gave no chat in the window reports no reading', async () => {
  const reason = 'Error encountered parsing conversations: List read only in part, with no conversation in the crawl window.';
  const outside = () => framework({ windowStart: Number.MAX_SAFE_INTEGER });
  const unreadable = [null, 'Title', null, null, null, [T, 0], null, null, null, 1];
  for (const [what, fake, side] of [
    ['both lists answer an error frame', client({ other: ERROR_FRAME, main: ERROR_FRAME }), framework()],
    ['an error frame, and chats outside the window', client({ other: ERROR_FRAME, main: listPage(entries(2)) }), outside()],
    ['an entry skipped, and no other', client({ main: listPage([unreadable]) }), framework()],
    ['a list cut at a repeated cursor, its chats outside the window', client({ main: listPage(entries(2), 'A'), more: { A: listPage(entries(2), 'A') } }), outside()],
  ] as const) {
    const run = await pass(fake, side);
    assert.deepEqual(run.outcome, { crawledCount: -1, crawledIds: [], reason, issue: reason }, what);
  }
});

test('a list read in full that gave no chat in the window is a reading of none', async () => {
  const run = await pass(client({ main: listPage(entries(2)) }), framework({ windowStart: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(run.outcome, { crawledCount: 0, crawledIds: [], reason: 'Fetch successful.', issue: null });
});

test('a key read that gets no answer ends the pass before anything is sent, with its own reason', { timeout: 2000 }, async () => {
  const run = await pass(client({ main: listPage(entries(3)) }), framework({ silentReads: true }));
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.sent.length], [-1, 'Crawl stopped: the extension storage did not answer.', 0]);
});

test('a stamp that gets no answer stops stamping and sending for the pass, which still says the list was read in full', { timeout: 2000 }, async () => {
  const side = framework({ silentStamps: true });
  const run = await pass(client({ main: listPage(entries(3)) }), side, { batch: 2 });
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, side.counts.stampTries, run.sent.map((record) => record.identifier)],
    [2, 'Fetch successful.', 1, [chatId(3), chatId(2)]]);
});

test('every store call is preceded by a keep-alive call', async () => {
  const side = framework({ held: [[chatId(1), T * 1000]] });
  const store = modes();
  const run = await pass(client({ main: listPage(entries(3)) }), side, {}, { store });
  assert.equal(run.keepAlives, side.counts.windows + side.counts.reads + side.counts.stampTries + store.counts.gets + store.counts.sets);
  // Two key reads for each unsent chat: its key in the served mode, then in the other.
  assert.deepEqual([side.counts.windows, side.counts.reads, side.counts.stampTries, store.counts.gets, store.counts.sets], [3, 5, 2, 1, 1], 'Test setup invalid: the pass made other store calls than expected');
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
    store: modes(),
    now: () => NOW,
    requestId: 1,
    limits: LIMITS,
    log: () => {},
  });
  // The newest record's dispatch threw; only the other was sent and stamped.
  assert.deepEqual([outcome.crawledCount, side.stamped], [1, [`${chatId(1)} ${T * 1000}`]]);
});

test('a pass never throws: a framework call that throws ends it with an error reason naming only the error\'s kind', async () => {
  const side = framework();
  side.fw.crawlWindowContains = async () => {
    throw new TypeError('secret detail');
  };
  const run = await pass(client({ main: listPage(entries(1)) }), side);
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [-1, 'Error encountered parsing conversations: internal error (TypeError).']);
});

test('enabled turning false stops the walk before its next list call, sends nothing and reports no reading', async () => {
  let calls = 0;
  const fake = client({ other: listPage(entries(1)), main: listPage(entries(2)) });
  // Read once before the homepage, once before the first list call.
  const side = framework({ enabled: () => (calls += 1) <= 2 });
  const run = await pass(fake, side);
  // -1, not 0: a count of 0 or more says crawledIds is a reading of the
  // chats in the window, and an empty one would read as an emptied account.
  assert.deepEqual(run.outcome, { crawledCount: -1, crawledIds: [], reason: 'Crawl stopped: spider disabled.', issue: null });
  assert.equal(run.sent.length, 0);
  assert.equal(fake.calls.filter((call) => call.startsWith('list')).length, 1, 'a list call went out after the spider was switched off');
  assert.equal(side.counts.reads, 0, 'chats were checked after the spider was switched off');
});

test('enabled turning false stops sending before the next batch, and the list read stays reported', async () => {
  let checks = 0;
  // The homepage and the two list calls read enabled once each; the first
  // batch reads it fourth.
  const side = framework({ enabled: () => (checks += 1) <= 4 });
  const run = await pass(client({ main: listPage(entries(3)) }), side, { batch: 2 });
  assert.deepEqual([run.outcome.crawledCount, run.outcome.crawledIds, run.outcome.reason, run.sent.map((record) => record.identifier)], [2, [chatId(1), chatId(2), chatId(3)], 'Crawl stopped: spider disabled.', [chatId(3), chatId(2)]]);
});

test('a spider switched off before its pass begins makes no request and reports no reading', async () => {
  const fake = client({ main: listPage(entries(1)) });
  const run = await pass(fake, framework({ enabled: () => false }));
  assert.deepEqual([run.outcome, fake.calls], [{ crawledCount: -1, crawledIds: [], reason: 'Crawl stopped: spider disabled.', issue: null }, []]);
});

test('a switch-off during the wait between list calls stops the next call', async () => {
  let switchedOff = false;
  const fake = client({ other: listPage(entries(1)), main: listPage(entries(2)) });
  const side = framework({ enabled: () => !switchedOff });
  const outcome = await runPass({
    client: fake,
    framework: side.fw,
    dispatch: () => {},
    sleep: async () => {
      switchedOff = true;
    },
    keepAlive: () => {},
    store: modes(),
    now: () => NOW,
    requestId: 1,
    limits: LIMITS,
    log: () => {},
  });
  assert.deepEqual([outcome.crawledCount, outcome.reason], [-1, 'Crawl stopped: spider disabled.']);
  assert.equal(fake.calls.filter((call) => call.startsWith('list')).length, 1, 'the call after the wait went out with the config read before it');
});

test('a stamp that throws or rejects stops stamping and sending, and the records sent stay counted', async () => {
  for (const failure of ['throws', 'rejects']) {
    const side = framework();
    side.fw.logTransmitted = () => {
      if (failure === 'throws') throw new TypeError('stamp broke');
      return Promise.reject(new TypeError('stamp broke'));
    };
    const run = await pass(client({ main: listPage(entries(3)) }), side, { batch: 2 });
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [2, 'Fetch successful.'], failure);
  }
});

test('an internal error is logged by the error\'s kind, never its message', async () => {
  const side = framework();
  side.fw.crawlWindowContains = async () => {
    throw new TypeError('secret detail');
  };
  const lines: string[] = [];
  await runPass({
    client: client({ main: listPage(entries(1)) }),
    framework: side.fw,
    dispatch: () => {},
    sleep: async () => {},
    keepAlive: () => {},
    store: modes(),
    now: () => NOW,
    requestId: 1,
    limits: LIMITS,
    log: (line) => lines.push(line),
  });
  assert.ok(lines.some((line) => line.includes('internal error (TypeError)')), `no line named the internal error:\n${lines.join('\n')}`);
  assert.ok(lines.every((line) => !line.includes('secret detail')), lines.join('\n'));
});

test('each store call comes right after its keep-alive call', async () => {
  const order: string[] = [];
  const side = framework();
  const { crawlWindowContains, checkIfAlreadyTransmitted, logTransmitted } = side.fw;
  side.fw.crawlWindowContains = (ms) => {
    order.push('window');
    return crawlWindowContains(ms);
  };
  side.fw.checkIfAlreadyTransmitted = (id, ended) => {
    order.push('read');
    return checkIfAlreadyTransmitted(id, ended);
  };
  side.fw.logTransmitted = (id, ended) => {
    order.push('stamp');
    return logTransmitted(id, ended);
  };
  const store = modes();
  const { get, set } = store.mode;
  store.mode.get = () => {
    order.push('mode read');
    return get();
  };
  store.mode.set = (record) => {
    order.push('mode write');
    return set(record);
  };
  await runPass({
    client: client({ main: listPage(entries(1)) }),
    framework: side.fw,
    store,
    now: () => NOW,
    dispatch: () => {},
    sleep: async () => {},
    keepAlive: () => {
      order.push('keep-alive');
    },
    requestId: 1,
    limits: LIMITS,
    log: () => {},
  });
  assert.deepEqual(order, ['keep-alive', 'mode read', 'keep-alive', 'mode write', 'keep-alive', 'window', 'keep-alive', 'read', 'keep-alive', 'read', 'keep-alive', 'stamp']);
});

test('a keep-alive that throws or rejects is logged and the pass goes on', async () => {
  for (const keepAlive of [() => { throw new TypeError('no storage'); }, () => Promise.reject(new TypeError('no storage'))]) {
    const lines: string[] = [];
    const outcome = await runPass({
      client: client({ main: listPage(entries(2)) }),
      framework: framework().fw,
      dispatch: () => {},
      sleep: async () => {},
      keepAlive,
      store: modes(),
      now: () => NOW,
      requestId: 1,
      limits: LIMITS,
      log: (line) => lines.push(line),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([outcome.crawledCount, outcome.reason], [2, 'Fetch successful.']);
    assert.ok(lines.some((line) => line.includes('keep-alive failed (TypeError)')), `the failed keep-alive was not logged:\n${lines.join('\n')}`);
  }
});

// Detail mode: one read per unsent chat, newest first, crawl_delay apart.
const readsOf = (fake: ReturnType<typeof client>) => fake.calls.filter((call) => call.startsWith('read')).map((call) => call.split(' ')[1]);
const keysOf = (side: ReturnType<typeof framework>) => side.stamped.map((key) => key.split(' ')[0]);

test('detail mode reads each unsent chat, newest first, and sends its detail record under the -detail key', async () => {
  const fake = client({ main: listPage(entries(2)) });
  const side = framework({ summarize: false });
  const run = await pass(fake, side);
  assert.deepEqual(readsOf(fake), [chatId(2), chatId(1)]);
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary, record.turns.length, record.date]), [[chatId(2), false, 1, (T - 60) * 1000], [chatId(1), false, 1, (T - 60) * 1000]]);
  assert.deepEqual(side.stamped, [`${chatId(2)}-detail ${(T + 1) * 1000}`, `${chatId(1)}-detail ${T * 1000}`]);
  assert.deepEqual(run.outcome, { crawledCount: 2, crawledIds: [chatId(1), chatId(2)], reason: 'Fetch successful.', issue: null });
});

test('a read asks for the chat by its read arguments, with the page token and request id', async () => {
  const fake = client({ main: listPage(entries(1)) });
  await pass(fake, framework({ summarize: false }));
  assert.deepEqual(fake.calls.filter((call) => call.startsWith('read')), [
    `read ${chatId(1)} ${JSON.stringify([chatId(1), 200, null, 1, [0], [4], null, 1])} rpcids=hNvQHb at=PAGE-TOKEN:1 _reqid=123456`,
  ]);
});

test('in detail mode a key is stamped after the wait that follows its record', async () => {
  const side = framework({ summarize: false });
  await pass(client({ main: listPage(entries(2)) }), side);
  // The first wait is the walk's, between its two list calls.
  assert.deepEqual(side.events, [
    'wait 30000',
    'wait 30000', `read ${chatId(2)}`, `dispatch ${chatId(2)}`,
    'wait 30000', `stamp ${chatId(2)}-detail`, `read ${chatId(1)}`, `dispatch ${chatId(1)}`,
    'wait 1500', `stamp ${chatId(1)}-detail`,
  ]);
});

test('a crawl_delay shorter than the settle wait, or not a number, still leaves the settle wait before a stamp', async () => {
  for (const [crawlDelay, pace] of [[10, 10], ['soon', 0], [-5, 0]] as const) {
    const side = framework({ summarize: false, crawlDelay });
    await pass(client({ main: listPage(entries(2)) }), side);
    assert.deepEqual(side.events.slice(1), [
      `wait ${pace}`, `read ${chatId(2)}`, `dispatch ${chatId(2)}`,
      'wait 1500', `stamp ${chatId(2)}-detail`, `read ${chatId(1)}`, `dispatch ${chatId(1)}`,
      'wait 1500', `stamp ${chatId(1)}-detail`,
    ], String(crawlDelay));
  }
});

test('the reads stop once the detail budget is spent, and the chats not reached keep no key', async () => {
  const fake = client({ main: listPage(entries(5)) });
  const side = framework({ summarize: false });
  // Each read follows a 30 s wait. With 90 s, reads go out at 30, 60 and 90 s;
  // a fourth would start its wait with the budget spent.
  const run = await pass(fake, side, { detailBudgetMs: 90_000 });
  assert.deepEqual(readsOf(fake), [chatId(5), chatId(4), chatId(3)]);
  assert.deepEqual(keysOf(side), [`${chatId(5)}-detail`, `${chatId(4)}-detail`, `${chatId(3)}-detail`]);
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [3, 'Fetch successful.']);
});

test('a switch-off during the reads stops them before the next read, and the record sent last is stamped', async () => {
  let checks = 0;
  // Read at the start, before each of the two list calls, then after each read's wait.
  const side = framework({ summarize: false, enabled: () => (checks += 1) <= 4 });
  const fake = client({ main: listPage(entries(2)) });
  const run = await pass(fake, side);
  assert.deepEqual(readsOf(fake), [chatId(2)]);
  assert.deepEqual(keysOf(side), [`${chatId(2)}-detail`]);
  assert.deepEqual(run.outcome, { crawledCount: 1, crawledIds: [chatId(1), chatId(2)], reason: 'Crawl stopped: spider disabled.', issue: null });
});

test('a failed read sends and stamps nothing for its chat, and the reads go on', async () => {
  const cases: [string, Answer][] = [
    ['a timeout', { kind: 'timeout' }],
    ['a network failure', { kind: 'network' }],
    ['HTTP 500', { kind: 'ok', status: 500, text: '' }],
    ['an error frame', { kind: 'ok', status: 200, text: batchResponse(wrbError('hNvQHb', 5)) }],
    ['HTML', { kind: 'ok', status: 200, text: '<html></html>' }],
  ];
  for (const [what, answer] of cases) {
    const side = framework({ summarize: false });
    const run = await pass(client({ main: listPage(entries(2)), reads: { [chatId(2)]: answer } }), side);
    assert.deepEqual([run.sent.map((record) => record.identifier), keysOf(side)], [[chatId(1)], [`${chatId(1)}-detail`]], what);
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [1, 'Fetch successful.'], what);
  }
});

test('an expired session ends the reads', async () => {
  const fake = client({ main: listPage(entries(2)), reads: { [chatId(2)]: EXPIRED_READ } });
  const side = framework({ summarize: false });
  const run = await pass(fake, side);
  assert.deepEqual([readsOf(fake), run.sent, side.stamped], [[chatId(2)], [], []]);
  assert.deepEqual(run.outcome, { crawledCount: 0, crawledIds: [chatId(1), chatId(2)], reason: 'Fetch successful.', issue: null });
});

test('a stamp that gets no answer stops the reads', { timeout: 2000 }, async () => {
  const fake = client({ main: listPage(entries(3)) });
  const side = framework({ summarize: false, silentStamps: true });
  const run = await pass(fake, side);
  assert.deepEqual([readsOf(fake), side.counts.stampTries, run.outcome.crawledCount, run.outcome.reason], [[chatId(3)], 1, 1, 'Fetch successful.']);
});

test('a dispatch that throws leaves its chat unstamped, and the reads go on', async () => {
  const side = framework({ summarize: false });
  const run = await pass(client({ main: listPage(entries(2)) }), side, {}, { throwOn: chatId(2) });
  assert.deepEqual([run.sent.map((record) => record.identifier), keysOf(side), run.outcome.crawledCount], [[chatId(1)], [`${chatId(1)}-detail`], 1]);
});

// The served mode, and the re-send after a change of mode.
test('the served mode is read once, when the pass starts', async () => {
  let asked = 0;
  // Summary the first time it is asked, detail after.
  const side = framework({ summarize: () => (asked += 1) === 1 });
  const store = modes();
  const run = await pass(client({ main: listPage(entries(2)) }), side, {}, { store });
  assert.deepEqual([asked, run.sent.map((record) => record.is_summary), store.writes], [1, [true, true], [{ mode: 'summary', since: NOW }]]);
});

test('the switch to detail re-sends the chats last used in the 90 days before it, and older chats keep their summary', async () => {
  const [old, recent, fresh] = [ago(100 * DAY), ago(DAY), ago(60_000)];
  // c_1 and c_2 were sent by a build that sent summaries only; c_3 is new.
  const side = framework({ summarize: false, held: [[chatId(1), old * 1000], [chatId(2), recent * 1000]] });
  const store = modes();
  const run = await pass(client({ main: listPage([listEntry(1, old), listEntry(2, recent), listEntry(3, fresh)]) }), side, {}, { store });
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(3), false], [chatId(2), false]]);
  assert.deepEqual(store.writes, [{ mode: 'detail', since: NOW }]);
});

test('a switch back to summary re-sends in summary the chats last used in the 90 days before it', async () => {
  const [old, recent] = [ago(100 * DAY), ago(DAY)];
  const side = framework({ held: [[`${chatId(1)}-detail`, old * 1000], [`${chatId(2)}-detail`, recent * 1000]] });
  const store = modes({ stored: { mode: 'detail', since: NOW - 30 * DAY } });
  const run = await pass(client({ main: listPage([listEntry(1, old), listEntry(2, recent)]) }), side, {}, { store });
  assert.deepEqual([run.sent.map((record) => [record.identifier, record.is_summary]), side.stamped], [[[chatId(2), true]], [`${chatId(2)} ${recent * 1000}`]]);
  assert.deepEqual(store.writes, [{ mode: 'summary', since: NOW }]);
});

test('a mode record that gets no answer holds back the chats sent in the other mode, and the next pass sends them', async () => {
  const [recent, fresh] = [ago(DAY), ago(60_000)];
  const side = framework({ summarize: false, held: [[chatId(1), recent * 1000]] });
  const listed = () => client({ main: listPage([listEntry(1, recent), listEntry(2, fresh)]) });
  const first = await pass(listed(), side, {}, { store: modes({ unanswered: true }) });
  const second = await pass(listed(), side, {}, { store: modes() });
  assert.deepEqual([first.sent.map((record) => record.identifier), second.sent.map((record) => record.identifier)], [[chatId(2)], [chatId(1)]]);
});

test('switching detail, summary, detail sends each chat once in each mode it is new to, then nothing', async () => {
  let summarize = false;
  const side = framework({ summarize: () => summarize });
  const store = modes();
  const sentAt = async (listed: unknown[][], now: number) => {
    const run = await pass(client({ main: listPage(listed) }), side, {}, { store, now });
    return run.sent.map((record) => `${record.identifier}${record.is_summary ? '' : '-detail'}`);
  };
  const [one, two, three] = [listEntry(1, ago(10 * DAY)), listEntry(2, ago(5 * DAY)), listEntry(3, ago(DAY))];
  assert.deepEqual(await sentAt([one, two], NOW), [`${chatId(2)}-detail`, `${chatId(1)}-detail`]);
  summarize = true;
  // c_3 is first listed now.
  assert.deepEqual(await sentAt([one, two, three], NOW + DAY), [chatId(3), chatId(2), chatId(1)]);
  summarize = false;
  assert.deepEqual(await sentAt([one, two, three], NOW + 2 * DAY), [`${chatId(3)}-detail`]);
  assert.deepEqual(await sentAt([one, two, three], NOW + 3 * DAY), []);
  summarize = true;
  assert.deepEqual(await sentAt([one, two, three], NOW + 4 * DAY), []);
});
