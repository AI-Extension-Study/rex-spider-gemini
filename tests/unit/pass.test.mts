import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DateString } from '@bric/rex-types/types';

import { type Answer } from '../../src/client.mts';
import { type PassFramework, runPass } from '../../src/pass.mts';
import { parseRead } from '../../src/read.mts';
import { type GeminiRecord } from '../../src/record.mts';
import { type DetailMemo, type ModeRecord } from '../../src/store.mts';
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
const LIMITS = { settleMs: 1500, batch: 25, storeMs: 20, detailBudgetMs: 360_000, failedRun: 3 };

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
// unkeptStamps: a stamp that is answered but not written, as rex-spider's
// logTransmitted resolves after a failed write. silentReadBacks: a read of a
// key stamped in this pass gets no answer; silentReadsAfter: every key read
// after that many; rejectedReadsAfter: every key read after that many
// rejects. haltOnError false is what the served configs say.
function framework({ windowStart = 0, held = [] as [string, number][], silentReads = false, silentStamps = false, unkeptStamps = false, silentReadBacks = false, silentReadsAfter = Infinity, rejectedReadsAfter = Infinity, haltOnError = false, enabled = (): boolean => true, summarize = true as boolean | (() => boolean), crawlDelay = 30_000 as unknown } = {}) {
  const keys = new Set(held.map(([id, ms]) => `${id} ${ms}`));
  const stampedNow = new Set<string>();
  const stamped: string[] = [];
  const events: string[] = [];
  const counts = { windows: 0, reads: 0, stampTries: 0 };
  const fw: PassFramework = {
    isEnabled: enabled,
    justSummarize: () => (typeof summarize === 'function' ? summarize() : summarize),
    continueAfterError: () => !haltOnError,
    crawlWindowContains: async (ms) => {
      counts.windows += 1;
      return ms >= windowStart;
    },
    checkIfAlreadyTransmitted: (id: string, ended: DateString) => {
      counts.reads += 1;
      const key = `${id} ${Math.round(ended.timestamp())}`;
      if (counts.reads > rejectedReadsAfter) return Promise.reject(new TypeError('store broke'));
      return silentReads || (silentReadBacks && stampedNow.has(key)) || counts.reads > silentReadsAfter ? new Promise(() => {}) : Promise.resolve(keys.has(key));
    },
    logTransmitted: (id: string, ended: DateString) => {
      counts.stampTries += 1;
      if (silentStamps) return new Promise(() => {});
      events.push(`stamp ${id}`);
      if (unkeptStamps) return Promise.resolve();
      const key = `${id} ${Math.round(ended.timestamp())}`;
      keys.add(key);
      stampedNow.add(key);
      stamped.push(key);
      return Promise.resolve();
    },
    fetchCrawlDelay: () => crawlDelay as number,
  };
  return { fw, stamped, events, counts };
}

// rex-core's store as the pass sees it (store.mts): the mode record and the
// memos of failed reads. unanswered: mode reads get no answer;
// memoUnanswered: memo reads get none; memoUnkept: memo writes fail;
// malformed: chats whose memo holds something that is not a memo.
function fakeStore({ stored = null as ModeRecord | null, unanswered = false, memos = {} as Record<string, DetailMemo>, memoUnanswered = false, memoUnkept = false, malformed = [] as string[] } = {}) {
  let value = stored;
  const writes: ModeRecord[] = [];
  const book = new Map(Object.entries(memos));
  const counts = { gets: 0, sets: 0, memoGets: 0, memoSets: 0, memoClears: 0 };
  return {
    writes,
    counts,
    memos: book,
    memo: {
      get: async (chatId: string) => {
        counts.memoGets += 1;
        if (malformed.includes(chatId)) return { value: null, unanswered: false, malformed: true };
        return { value: memoUnanswered ? null : book.get(chatId) ?? null, unanswered: memoUnanswered, malformed: false };
      },
      set: async (chatId: string, memo: DetailMemo) => {
        counts.memoSets += 1;
        if (memoUnkept) return { ok: false, unanswered: false };
        book.set(chatId, memo);
        return { ok: true, unanswered: false };
      },
      clear: async (chatId: string) => {
        counts.memoClears += 1;
        book.delete(chatId);
        malformed.splice(0, malformed.length, ...malformed.filter((id) => id !== chatId));
        return { ok: true, unanswered: false };
      },
    },
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

// One pass with the fakes. The clock starts at now and moves with the waits,
// and by readMs with each chat read, so a test can spend the detail budget,
// which counts the reads and not the waits.
async function pass(fake: ReturnType<typeof client>, side: ReturnType<typeof framework>, limits = {}, { store = fakeStore(), now = NOW, throwOn = null as string | null, readMs = 0 } = {}) {
  const sent: GeminiRecord[] = [];
  const waits: number[] = [];
  let keepAlives = 0;
  let clock = now;
  const outcome = await runPass({
    client: {
      get: fake.get,
      postForm: (url, body) => {
        const [rpcid, json] = JSON.parse(body.get('f.req') ?? '')[0][0] as [string, string];
        if (rpcid === 'hNvQHb') {
          side.events.push(`read ${String((JSON.parse(json) as unknown[])[0])}`);
          clock += readMs;
        }
        return fake.postForm(url, body);
      },
    },
    framework: side.fw,
    store: {
      mode: store.mode,
      memo: {
        get: (chatId) => store.memo.get(chatId),
        set: (chatId, memo) => {
          side.events.push(`memo ${chatId}`);
          return store.memo.set(chatId, memo);
        },
        clear: (chatId) => {
          side.events.push(`clear ${chatId}`);
          return store.memo.clear(chatId);
        },
      },
    },
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
  const store = fakeStore();
  const run = await pass(client({ main: listPage(entries(3)) }), side, {}, { store });
  assert.equal(run.keepAlives, side.counts.windows + side.counts.reads + side.counts.stampTries + store.counts.gets + store.counts.sets);
  // Two key reads for each unsent chat, its key in the served mode, then in
  // the other; and one after each stamp, reading it back.
  assert.deepEqual([side.counts.windows, side.counts.reads, side.counts.stampTries, store.counts.gets, store.counts.sets], [3, 7, 2, 1, 1], 'Test setup invalid: the pass made other store calls than expected');
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
    store: fakeStore(),
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
    store: fakeStore(),
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
    store: fakeStore(),
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
  const store = fakeStore();
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
  assert.deepEqual(order, ['keep-alive', 'mode read', 'keep-alive', 'mode write', 'keep-alive', 'window', 'keep-alive', 'read', 'keep-alive', 'read', 'keep-alive', 'stamp', 'keep-alive', 'read']);
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
      store: fakeStore(),
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
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary, record.turns.length, record.date]), [[chatId(2), false, 2, (T - 60) * 1000], [chatId(1), false, 2, (T - 60) * 1000]]);
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

test('a crawl_delay shorter than the settle wait, or not a number, still leaves the settle wait between reads and before a stamp', async () => {
  for (const crawlDelay of [10, 'soon', -5]) {
    const side = framework({ summarize: false, crawlDelay });
    await pass(client({ main: listPage(entries(2)) }), side);
    assert.deepEqual(side.events.slice(1), [
      'wait 1500', `read ${chatId(2)}`, `dispatch ${chatId(2)}`,
      'wait 1500', `stamp ${chatId(2)}-detail`, `read ${chatId(1)}`, `dispatch ${chatId(1)}`,
      'wait 1500', `stamp ${chatId(1)}-detail`,
    ], String(crawlDelay));
  }
});

// The detail budget, 360 s here as in the spider, counts reading time only:
// requests, parsing and store calls, never the waits between reads.
// newest(count, n): the n newest chats of entries(count), in the order read.
const newest = (count: number, n: number) => Array.from({ length: n }, (_, i) => chatId(count - i));

test('the waits do not spend the detail budget: 20 chats at a 30 s crawl_delay are all read in one pass, and none outside the window', async () => {
  // c_1 and c_2 are older than the window's start; c_3 to c_22 are in it.
  const fake = client({ main: listPage(entries(22)) });
  const side = framework({ summarize: false, crawlDelay: 30_000, windowStart: (T + 2) * 1000 });
  const run = await pass(fake, side);
  assert.deepEqual(readsOf(fake), newest(22, 20));
  assert.deepEqual(keysOf(side), newest(22, 20).map((id) => `${id}-detail`));
  // After the walk's wait, a 30 s wait before each read, 600 s in all and
  // past the budget, then the settle wait before the last stamp.
  assert.deepEqual(run.waits.slice(1), [...Array.from({ length: 20 }, () => 30_000), 1500]);
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [20, 'Fetch successful.']);
});

test('the reads stop at the read that takes reading time to the detail budget or past it, and the chats not reached keep no key', async () => {
  // Reads of 50 s: seven take 350 s and the eighth brings reading to 400 s,
  // past the budget. Reads of 45 s: the eighth brings it to 360 s exactly.
  // Either way no ninth goes out. On the wall clock, waits included, the
  // budget would end the reads after five.
  for (const readMs of [50_000, 45_000]) {
    const fake = client({ main: listPage(entries(10)) });
    const side = framework({ summarize: false, crawlDelay: 30_000 });
    const run = await pass(fake, side, {}, { readMs });
    assert.deepEqual(readsOf(fake), newest(10, 8), String(readMs));
    assert.deepEqual(keysOf(side), newest(10, 8).map((id) => `${id}-detail`), String(readMs));
    // The record sent last waits out the settle time before its stamp.
    assert.deepEqual(side.events.slice(-3), [`dispatch ${chatId(3)}`, 'wait 1500', `stamp ${chatId(3)}-detail`], String(readMs));
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [8, 'Fetch successful.'], String(readMs));
  }
});

test('a rate limit or an overloaded server still ends the reads at once after the waits have passed the budget', async () => {
  const wait = 'Crawl stopped: the server asked to wait.';
  for (const status of [429, 503]) {
    // The 15th read, of c_6, is refused 450 s of waits into the reads.
    const fake = client({ main: listPage(entries(20)), reads: { [chatId(6)]: { kind: 'ok', status, text: '' } } });
    const run = await pass(fake, framework({ summarize: false, crawlDelay: 30_000 }));
    assert.deepEqual(readsOf(fake), newest(20, 15), String(status));
    // 14 detail records, and c_6's summary in its place.
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.outcome.issue], [15, wait, wait], String(status));
  }
});

test('a switch-off still ends the pass after the waits have passed the budget', async () => {
  const fake = client({ main: listPage(entries(20)) });
  // The served config says enabled: false once 15 chats were read, 450 s of
  // waits into the reads.
  const side = framework({ summarize: false, crawlDelay: 30_000, enabled: () => readsOf(fake).length < 15 });
  const run = await pass(fake, side);
  assert.deepEqual(readsOf(fake), newest(20, 15));
  // The record sent last is stamped after the wait, before the check that ends the pass.
  assert.deepEqual(keysOf(side), newest(20, 15).map((id) => `${id}-detail`));
  assert.deepEqual([run.outcome.crawledCount, run.outcome.reason, run.outcome.issue], [15, 'Crawl stopped: spider disabled.', null]);
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

test('a failed read sends the summary record in its place, unstamped, writes a memo, and the reads go on', async () => {
  // The HTTP 500 case carries a body that reads as a read, so only its status can fail it.
  const readable = readResponse([exchange({ chat: chatId(2), response: 1, seconds: T - 60 })]);
  assert.equal(parseRead(readable, chatId(2)).kind, 'read', 'Test setup invalid: the HTTP 500 body does not read as a read');
  const cases: [string, Answer][] = [
    ['a timeout', { kind: 'timeout' }],
    ['a network failure', { kind: 'network' }],
    ['HTTP 500', { kind: 'ok', status: 500, text: readable }],
    ['an error frame', { kind: 'ok', status: 200, text: batchResponse(wrbError('hNvQHb', 5)) }],
    ['HTML', { kind: 'ok', status: 200, text: '<html></html>' }],
  ];
  for (const [what, answer] of cases) {
    const side = framework({ summarize: false });
    const store = fakeStore();
    const run = await pass(client({ main: listPage(entries(2)), reads: { [chatId(2)]: answer } }), side, {}, { store });
    assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(2), true], [chatId(1), false]], what);
    assert.deepEqual([keysOf(side), [...store.memos.keys()]], [[`${chatId(1)}-detail`], [chatId(2)]], what);
    assert.deepEqual([run.outcome.crawledCount, run.outcome.reason], [2, 'Fetch successful.'], what);
  }
});

test('an expired session ends the reads, after the record sent before it was stamped', async () => {
  const fake = client({ main: listPage(entries(3)), reads: { [chatId(2)]: EXPIRED_READ } });
  const side = framework({ summarize: false });
  const run = await pass(fake, side);
  assert.deepEqual([readsOf(fake), run.sent.map((record) => record.identifier)], [[chatId(3), chatId(2)], [chatId(3)]]);
  assert.deepEqual(side.events.slice(-3), ['wait 30000', `stamp ${chatId(3)}-detail`, `read ${chatId(2)}`]);
  assert.deepEqual(run.outcome, { crawledCount: 1, crawledIds: [chatId(1), chatId(2), chatId(3)], reason: 'Fetch successful.', issue: null });
});

test('a stamp the store does not keep stops the sending, in either mode', async () => {
  const summary = framework({ unkeptStamps: true });
  const inSummary = await pass(client({ main: listPage(entries(3)) }), summary, { batch: 2 });
  assert.deepEqual([inSummary.sent.length, summary.counts.stampTries, inSummary.outcome.crawledCount], [2, 1, 2], 'summary');
  const fake = client({ main: listPage(entries(3)) });
  const detail = framework({ summarize: false, unkeptStamps: true });
  const inDetail = await pass(fake, detail);
  assert.deepEqual([readsOf(fake), detail.counts.stampTries, inDetail.outcome.crawledCount], [[chatId(3)], 1, 1], 'detail');
});

test('a read-back that gets no answer stops the sending', { timeout: 2000 }, async () => {
  const side = framework({ silentReadBacks: true });
  const run = await pass(client({ main: listPage(entries(3)) }), side, { batch: 2 });
  assert.deepEqual([run.sent.length, side.counts.stampTries, run.outcome.crawledCount, run.outcome.reason], [2, 1, 2, 'Fetch successful.']);
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
  const store = fakeStore();
  const run = await pass(client({ main: listPage(entries(2)) }), side, {}, { store });
  assert.deepEqual([asked, run.sent.map((record) => record.is_summary), store.writes], [1, [true, true], [{ mode: 'summary', since: NOW }]]);
});

test('the switch to detail re-sends the chats last used in the 90 days before it, and older chats keep their summary', async () => {
  const [old, recent, fresh] = [ago(100 * DAY), ago(DAY), ago(60_000)];
  // c_1 and c_2 were sent by a build that sent summaries only; c_3 is new.
  const side = framework({ summarize: false, held: [[chatId(1), old * 1000], [chatId(2), recent * 1000]] });
  const store = fakeStore();
  const run = await pass(client({ main: listPage([listEntry(1, old), listEntry(2, recent), listEntry(3, fresh)]) }), side, {}, { store });
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(3), false], [chatId(2), false]]);
  assert.deepEqual(store.writes, [{ mode: 'detail', since: NOW }]);
});

test('a switch back to summary re-sends in summary the chats last used in the 90 days before it', async () => {
  const [old, recent] = [ago(100 * DAY), ago(DAY)];
  const side = framework({ held: [[`${chatId(1)}-detail`, old * 1000], [`${chatId(2)}-detail`, recent * 1000]] });
  const store = fakeStore({ stored: { mode: 'detail', since: NOW - 30 * DAY } });
  const run = await pass(client({ main: listPage([listEntry(1, old), listEntry(2, recent)]) }), side, {}, { store });
  assert.deepEqual([run.sent.map((record) => [record.identifier, record.is_summary]), side.stamped], [[[chatId(2), true]], [`${chatId(2)} ${recent * 1000}`]]);
  assert.deepEqual(store.writes, [{ mode: 'summary', since: NOW }]);
});

test('a mode record that gets no answer holds back the chats sent in the other mode, and the next pass sends them', async () => {
  const [recent, fresh] = [ago(DAY), ago(60_000)];
  const side = framework({ summarize: false, held: [[chatId(1), recent * 1000]] });
  const listed = () => client({ main: listPage([listEntry(1, recent), listEntry(2, fresh)]) });
  const first = await pass(listed(), side, {}, { store: fakeStore({ unanswered: true }) });
  const second = await pass(listed(), side, {}, { store: fakeStore() });
  assert.deepEqual([first.sent.map((record) => record.identifier), second.sent.map((record) => record.identifier)], [[chatId(2)], [chatId(1)]]);
});

test('switching detail, summary, detail sends each chat once in each mode it is new to, then nothing', async () => {
  let summarize = false;
  const side = framework({ summarize: () => summarize });
  const store = fakeStore();
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

// Failed reads: the summary record in the detail's place, a memo that holds
// the chat back, and the stops.
const ERROR_READ: Answer = { kind: 'ok', status: 200, text: batchResponse(wrbError('hNvQHb', 5)) };
const memoOf = (store: ReturnType<typeof fakeStore>, n: number) => store.memos.get(chatId(n));
const STOPPED = 'Crawl stopped: detail reads failed.';

test('a failed read writes its memo after the wait that follows it, as a stamp is written', async () => {
  const side = framework({ summarize: false });
  const store = fakeStore();
  await pass(client({ main: listPage(entries(2)), reads: { [chatId(2)]: ERROR_READ } }), side, {}, { store });
  assert.deepEqual(side.events, [
    'wait 30000',
    'wait 30000', `read ${chatId(2)}`, `dispatch ${chatId(2)}`,
    'wait 30000', `memo ${chatId(2)}`, `read ${chatId(1)}`, `dispatch ${chatId(1)}`,
    'wait 1500', `stamp ${chatId(1)}-detail`,
  ]);
  // The read failed a minute into the pass: the walk's wait, then its own.
  assert.deepEqual(memoOf(store, 2), { ended: (T + 1) * 1000, at: NOW + 60_000, retryMs: 7 * DAY, failures: 1 });
});

test('the retry comes a day after a first failure that may pass, and a week after any other', async () => {
  const cases: [string, Answer, number][] = [
    ['a timeout', { kind: 'timeout' }, DAY],
    ['a network failure', { kind: 'network' }, DAY],
    ['HTTP 500', { kind: 'ok', status: 500, text: '' }, DAY],
    ['HTTP 503', { kind: 'ok', status: 503, text: '' }, DAY],
    ['HTTP 429', { kind: 'ok', status: 429, text: '' }, DAY],
    ['HTTP 404', { kind: 'ok', status: 404, text: '' }, 7 * DAY],
    ['an error frame', ERROR_READ, 7 * DAY],
    ['HTML', { kind: 'ok', status: 200, text: '<html></html>' }, 7 * DAY],
  ];
  for (const [what, answer, retryMs] of cases) {
    const store = fakeStore();
    await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: answer } }), framework({ summarize: false }), {}, { store });
    assert.equal(memoOf(store, 1)?.retryMs, retryMs, what);
  }
});

test('a chat whose read fails again waits a week, and sends no second summary for the same last message', async () => {
  const store = fakeStore({ memos: { [chatId(1)]: { ended: T * 1000, at: NOW - 2 * DAY, retryMs: DAY, failures: 1 } } });
  const fake = client({ main: listPage(entries(1)), reads: { [chatId(1)]: { kind: 'timeout' } } });
  const run = await pass(fake, framework({ summarize: false }), {}, { store });
  assert.deepEqual([readsOf(fake), run.sent], [[chatId(1)], []]);
  assert.deepEqual(memoOf(store, 1), { ended: T * 1000, at: NOW + 60_000, retryMs: 7 * DAY, failures: 2 });
});

test('a memo holds its chat back until its retry time, and a new last message reads it at once', async () => {
  const cases: [string, DetailMemo, number][] = [
    ['within the retry time', { ended: T * 1000, at: NOW - 1000, retryMs: DAY, failures: 1 }, 0],
    ['past the retry time', { ended: T * 1000, at: NOW - DAY - 1000, retryMs: DAY, failures: 1 }, 1],
    ['for an earlier last message', { ended: (T - 60) * 1000, at: NOW - 1000, retryMs: 7 * DAY, failures: 3 }, 1],
  ];
  for (const [what, memo, reads] of cases) {
    const fake = client({ main: listPage(entries(1)) });
    await pass(fake, framework({ summarize: false }), {}, { store: fakeStore({ memos: { [chatId(1)]: memo } }) });
    assert.equal(readsOf(fake).length, reads, what);
  }
});

test('a successful read clears the memo', async () => {
  const store = fakeStore({ memos: { [chatId(1)]: { ended: (T - 60) * 1000, at: NOW - 1000, retryMs: DAY, failures: 1 } } });
  await pass(client({ main: listPage(entries(1)) }), framework({ summarize: false }), {}, { store });
  assert.equal(store.memos.has(chatId(1)), false);
});

test('a failed read sends no summary for a chat whose summary was sent at this last message', async () => {
  // A build that sent summaries only sent c_1 at this time.
  const store = fakeStore();
  const run = await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } }), framework({ summarize: false, held: [[chatId(1), T * 1000]] }), {}, { store });
  assert.deepEqual([run.sent, memoOf(store, 1)?.failures], [[], 1]);
});

test('an old chat whose read failed is read again once its memo has run out', async () => {
  // Last used 100 days ago and never sent. Were its summary key stamped, the
  // re-send rule would count it as sent from then on.
  const old = ago(100 * DAY);
  const side = framework({ summarize: false });
  const store = fakeStore();
  const failed = await pass(client({ main: listPage([listEntry(1, old)]), reads: { [chatId(1)]: ERROR_READ } }), side, {}, { store });
  assert.deepEqual([failed.sent.map((record) => record.is_summary), side.stamped], [[true], []]);
  const later = client({ main: listPage([listEntry(1, old)]) });
  const retried = await pass(later, side, {}, { store, now: NOW + 8 * DAY });
  assert.deepEqual([readsOf(later), retried.sent.map((record) => record.is_summary)], [[chatId(1)], [false]]);
});

test('halt_on_error true ends the reads at the first failed read', async () => {
  const fake = client({ main: listPage(entries(3)), reads: { [chatId(3)]: ERROR_READ } });
  const side = framework({ summarize: false, haltOnError: true });
  const run = await pass(fake, side);
  assert.deepEqual([readsOf(fake), side.events.slice(-2)], [[chatId(3)], ['wait 1500', `memo ${chatId(3)}`]]);
  assert.deepEqual(run.outcome, { crawledCount: 1, crawledIds: [chatId(1), chatId(2), chatId(3)], reason: STOPPED, issue: STOPPED });
});

test('halt_on_error false goes on past a failed read, and three in a row end the reads', async () => {
  const fake = client({ main: listPage(entries(5)), reads: { [chatId(5)]: ERROR_READ, [chatId(4)]: ERROR_READ, [chatId(3)]: ERROR_READ } });
  const run = await pass(fake, framework({ summarize: false }));
  assert.deepEqual([readsOf(fake), run.outcome.crawledCount, run.outcome.reason], [[chatId(5), chatId(4), chatId(3)], 3, STOPPED]);
});

test('a read that succeeds between failed ones starts the count of three again', async () => {
  const fake = client({ main: listPage(entries(5)), reads: { [chatId(5)]: ERROR_READ, [chatId(4)]: ERROR_READ, [chatId(2)]: ERROR_READ, [chatId(1)]: ERROR_READ } });
  const run = await pass(fake, framework({ summarize: false }));
  assert.deepEqual([readsOf(fake).length, run.outcome.crawledCount, run.outcome.reason], [5, 5, 'Fetch successful.']);
});

test('a memo read that gets no answer holds its chat back for the pass', async () => {
  const fake = client({ main: listPage(entries(2)) });
  const run = await pass(fake, framework({ summarize: false }), {}, { store: fakeStore({ memoUnanswered: true }) });
  assert.deepEqual([readsOf(fake), run.outcome.crawledCount, run.outcome.reason], [[], 0, 'Fetch successful.']);
});

test('a memo the store does not keep stops the sending', async () => {
  const fake = client({ main: listPage(entries(3)), reads: { [chatId(3)]: ERROR_READ } });
  const run = await pass(fake, framework({ summarize: false }), {}, { store: fakeStore({ memoUnkept: true }) });
  assert.deepEqual([readsOf(fake), run.outcome.crawledCount, run.outcome.reason], [[chatId(3)], 1, 'Fetch successful.']);
});

test('a summary key check that gets no answer stops the sending, and no memo is written', { timeout: 2000 }, async () => {
  // The inspection reads the chat's two keys; the third read is the check before its summary.
  const store = fakeStore();
  const run = await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } }), framework({ summarize: false, silentReadsAfter: 2 }), {}, { store });
  assert.deepEqual([run.sent, store.memos.size, run.outcome.crawledCount, run.outcome.reason], [[], 0, 0, 'Fetch successful.']);
});

test('in detail mode every store call is preceded by a keep-alive call, memo calls included', async () => {
  const side = framework({ summarize: false });
  const store = fakeStore({ memos: { [chatId(1)]: { ended: (T - 60) * 1000, at: NOW, retryMs: DAY, failures: 1 } } });
  const run = await pass(client({ main: listPage(entries(2)), reads: { [chatId(2)]: ERROR_READ } }), side, {}, { store });
  const { counts } = store;
  assert.equal(run.keepAlives, side.counts.windows + side.counts.reads + side.counts.stampTries + counts.gets + counts.sets + counts.memoGets + counts.memoSets + counts.memoClears);
  assert.deepEqual([counts.memoGets, counts.memoSets, counts.memoClears], [2, 1, 1], 'Test setup invalid: the pass made other memo calls than expected');
});

test('a summary that could not be dispatched writes no memo, so the next pass reads the chat and sends it', async () => {
  const side = framework({ summarize: false });
  const store = fakeStore();
  const listed = () => client({ main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } });
  const first = await pass(listed(), side, {}, { store, throwOn: chatId(1) });
  assert.deepEqual([first.sent, store.memos.size], [[], 0]);
  const second = await pass(listed(), side, {}, { store });
  assert.deepEqual([second.sent.map((record) => [record.identifier, record.is_summary]), memoOf(store, 1)?.failures], [[[chatId(1), true]], 1]);
});

test('a failed read of a newer last message sends its summary and starts the memo again', async () => {
  const store = fakeStore({ memos: { [chatId(1)]: { ended: (T - 60) * 1000, at: NOW - 1000, retryMs: 7 * DAY, failures: 3 } } });
  const run = await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } }), framework({ summarize: false }), {}, { store });
  assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(1), true]]);
  assert.deepEqual(memoOf(store, 1), { ended: T * 1000, at: NOW + 60_000, retryMs: 7 * DAY, failures: 1 });
});

test('a rate limit or an overloaded server sends the summary, holds the chat back, and ends the reads', async () => {
  const wait = 'Crawl stopped: the server asked to wait.';
  for (const status of [429, 503]) {
    const fake = client({ main: listPage(entries(3)), reads: { [chatId(2)]: { kind: 'ok', status, text: '' } } });
    const side = framework({ summarize: false });
    const store = fakeStore();
    const run = await pass(fake, side, {}, { store });
    assert.deepEqual(readsOf(fake), [chatId(3), chatId(2)], String(status));
    assert.deepEqual(run.sent.map((record) => [record.identifier, record.is_summary]), [[chatId(3), false], [chatId(2), true]], String(status));
    // The record before it is stamped, and the memo written after a settle wait.
    assert.deepEqual([keysOf(side), side.events.slice(-2), memoOf(store, 2)?.retryMs], [[`${chatId(3)}-detail`], ['wait 1500', `memo ${chatId(2)}`], DAY], String(status));
    assert.deepEqual(run.outcome, { crawledCount: 2, crawledIds: [chatId(1), chatId(2), chatId(3)], reason: wait, issue: wait }, String(status));
  }
});

test('chats held back by a memo neither count toward the run of failed reads nor end it', async () => {
  const held: DetailMemo = { ended: (T + 3) * 1000, at: NOW - 1000, retryMs: DAY, failures: 1 };
  const fake = client({ main: listPage(entries(5)), reads: { [chatId(5)]: ERROR_READ, [chatId(3)]: ERROR_READ, [chatId(2)]: ERROR_READ } });
  const run = await pass(fake, framework({ summarize: false }), {}, { store: fakeStore({ memos: { [chatId(4)]: held } }) });
  assert.deepEqual([readsOf(fake), run.outcome.reason], [[chatId(5), chatId(3), chatId(2)], STOPPED]);
});

test('a 429 says the server asked to wait with halt_on_error too, and after a list read only in part keeps the partial reason', async () => {
  const wait = 'Crawl stopped: the server asked to wait.';
  const limited: Answer = { kind: 'ok', status: 429, text: '' };
  const halted = await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: limited } }), framework({ summarize: false, haltOnError: true }));
  assert.deepEqual([halted.outcome.reason, halted.outcome.issue], [wait, wait], 'halt_on_error');
  const partial = await pass(client({ other: ERROR_FRAME, main: listPage(entries(1)), reads: { [chatId(1)]: limited } }), framework({ summarize: false }));
  assert.deepEqual([partial.outcome.reason, partial.outcome.issue], ['Full fetch unsuccessful. Partial results returned.', wait], 'partial list');
});

test('chats that fail again count toward the run of failed reads too', async () => {
  // A read that fails for every chat would otherwise run through all the
  // chats whose memos ran out, up to the budget.
  const again = (n: number): DetailMemo => ({ ended: (T + n - 1) * 1000, at: NOW - 8 * DAY, retryMs: 7 * DAY, failures: 1 });
  const fake = client({ main: listPage(entries(5)), reads: { [chatId(5)]: ERROR_READ, [chatId(4)]: ERROR_READ, [chatId(3)]: ERROR_READ } });
  const store = fakeStore({ memos: { [chatId(5)]: again(5), [chatId(4)]: again(4), [chatId(3)]: again(3) } });
  const run = await pass(fake, framework({ summarize: false }), {}, { store });
  assert.deepEqual([readsOf(fake), run.outcome.reason], [[chatId(5), chatId(4), chatId(3)], STOPPED]);
});

test('a summary key check that fails stops the sending, and no memo is written', async () => {
  const store = fakeStore();
  const run = await pass(client({ main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } }), framework({ summarize: false, rejectedReadsAfter: 2 }), {}, { store });
  assert.deepEqual([run.sent, store.memos.size, run.outcome.crawledCount, run.outcome.reason], [[], 0, 0, 'Fetch successful.']);
});

test('failed reads after a list read only in part keep the partial reason, and name the failure as the issue', async () => {
  const fake = client({ other: ERROR_FRAME, main: listPage(entries(1)), reads: { [chatId(1)]: ERROR_READ } });
  const run = await pass(fake, framework({ summarize: false, haltOnError: true }));
  assert.deepEqual(run.outcome, { crawledCount: 1, crawledIds: [chatId(1)], reason: 'Full fetch unsuccessful. Partial results returned.', issue: STOPPED });
});

test('a memo from a clock that ran fast does not hold its chat back', async () => {
  const fake = client({ main: listPage(entries(1)) });
  const store = fakeStore({ memos: { [chatId(1)]: { ended: T * 1000, at: NOW + 3 * DAY, retryMs: DAY, failures: 1 } } });
  await pass(fake, framework({ summarize: false }), {}, { store });
  assert.deepEqual(readsOf(fake), [chatId(1)]);
});

test('a memo that holds something else is read as none, and a successful read clears it', async () => {
  const fake = client({ main: listPage(entries(1)) });
  const store = fakeStore({ malformed: [chatId(1)] });
  await pass(fake, framework({ summarize: false }), {}, { store });
  assert.deepEqual([readsOf(fake), store.counts.memoClears], [[chatId(1)], 1]);
});
