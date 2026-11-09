import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Answer } from '../../src/client.mts';
import { walkList } from '../../src/walk.mts';
import { batchResponse, chatId, listEntry, wrb, wrbError } from './batch.mts';

const MAIN = [0, null, 1];
const OTHER = [1, null, 1];

const page = (entries: unknown[][], next: string | null = null): Answer => ({ kind: 'ok', status: 200, text: batchResponse(wrb('MaZiqc', [null, next, entries])) });
const entry = (n: number) => listEntry(n, 1700000000 - n);

// A fake list server: answers each call by its variant and cursor, and
// records the arguments of every call in order.
function server(answers: Record<string, Answer>) {
  const calls: unknown[][] = [];
  const sent: { url: string; at: string | null }[] = [];
  const client = {
    postForm: async (url: string, body: URLSearchParams): Promise<Answer> => {
      const args = JSON.parse(JSON.parse(body.get('f.req') ?? '')[0][0][1]) as unknown[];
      calls.push(args);
      sent.push({ url, at: body.get('at') });
      const answer = answers[`${JSON.stringify(args[2])} ${String(args[1])}`];
      if (answer === undefined) throw new Error(`no answer scripted for ${JSON.stringify(args)}`);
      return answer;
    },
  };
  return { calls, sent, client };
}

function walk(answers: Record<string, Answer>, extra: { maxPages?: number } = {}) {
  const fake = server(answers);
  const waits: number[] = [];
  const result = walkList({ client: fake.client, sleep: async (ms) => { waits.push(ms); }, crawlDelay: () => 30_000, at: 'TOKEN', requestId: 123456, log: () => {}, ...extra });
  return { result, calls: fake.calls, sent: fake.sent, waits };
}

const key = (variant: unknown[], cursor: string | null) => `${JSON.stringify(variant)} ${String(cursor)}`;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

test('walks [1,null,1] and then [0,null,1], following each one\'s cursor, with crawl_delay between calls', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(2)]),
    [key(MAIN, null)]: page([entry(3)], 'A2'),
    [key(MAIN, 'A2')]: page([entry(4)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, null, MAIN], [10, 'A2', MAIN]]);
  assert.deepEqual(run.waits, [30_000, 30_000, 30_000]);
  assert.deepEqual({ ids: ids(result.items), complete: result.complete, stop: result.stop }, { ids: [chatId(1), chatId(2), chatId(3), chatId(4)], complete: true, stop: null });
});

test('a cursor that comes back again ends that variant\'s paging and leaves the walk incomplete', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(2)], 'B2'),
    [key(MAIN, null)]: page([entry(3)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, null, MAIN]]);
  assert.deepEqual({ ids: ids(result.items), complete: result.complete }, { ids: [chatId(1), chatId(2), chatId(3)], complete: false });
});

test('three pages in a row that bring no chat the list had not given end its paging, and the walk is incomplete', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(1)], 'B3'),
    [key(OTHER, 'B3')]: page([entry(1)], 'B4'),
    [key(OTHER, 'B4')]: page([entry(1)], 'B5'),
    [key(MAIN, null)]: page([]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, 'B3', OTHER], [10, 'B4', OTHER], [10, null, MAIN]]);
  assert.equal(result.complete, false);
});

test('empty pages that keep handing out new cursors are cut after three', async () => {
  const run = walk({
    [key(OTHER, null)]: page([], 'B2'),
    [key(OTHER, 'B2')]: page([], 'B3'),
    [key(OTHER, 'B3')]: page([], 'B4'),
    [key(MAIN, null)]: page([entry(1)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, 'B3', OTHER], [10, null, MAIN]]);
  assert.deepEqual({ ids: ids(result.items), complete: result.complete }, { ids: [chatId(1)], complete: false });
});

test('a page whose entries were all skipped still counts as paging moving on', async () => {
  const bad = ['c_bad', 'Title', null, null, null, null];
  const run = walk({
    [key(OTHER, null)]: page([bad], 'B2'),
    [key(OTHER, 'B2')]: page([bad], 'B3'),
    [key(OTHER, 'B3')]: page([bad], 'B4'),
    [key(OTHER, 'B4')]: page([entry(1)]),
    [key(MAIN, null)]: page([]),
  });
  await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, 'B3', OTHER], [10, 'B4', OTHER], [10, null, MAIN]]);
});

test('a variant still handing out new cursors after maxPages pages is cut, and the walk is incomplete', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(2)], 'B3'),
    [key(OTHER, 'B3')]: page([entry(3)], 'B4'),
    [key(MAIN, null)]: page([]),
  }, { maxPages: 3 });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, 'B3', OTHER], [10, null, MAIN]]);
  assert.equal(result.complete, false);
});

test('an error frame ends that variant, the walk goes on to the next one, and it is incomplete', async () => {
  const run = walk({
    [key(OTHER, null)]: { kind: 'ok', status: 200, text: batchResponse(wrbError('MaZiqc', 3)) },
    [key(MAIN, null)]: page([entry(1)]),
  });
  const result = await run.result;
  assert.deepEqual({ ids: ids(result.items), complete: result.complete, stop: result.stop }, { ids: [chatId(1)], complete: false, stop: null });
});

test('an entry the parser skips leaves the walk incomplete and keeps the rest', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1), ['c_bad', 'Title', null, null, null, null]]),
    [key(MAIN, null)]: page([entry(2)]),
  });
  const result = await run.result;
  assert.deepEqual({ ids: ids(result.items), complete: result.complete }, { ids: [chatId(1), chatId(2)], complete: false });
});

test('an answer that stops the walk keeps what came before and names why', async () => {
  const html: Answer = { kind: 'ok', status: 200, text: '<!doctype html><title>Sign in</title>' };
  const expired: Answer = { kind: 'ok', status: 200, text: `)]}'\n\n90\n[["wrb.fr","MaZiqc",null,null,null,[16],"generic",[["type.googleapis.com/assistant.boq.bard.application.BardErrorInfo",[1096]]]]]\n` };
  const cases: [Answer, unknown][] = [
    [html, { kind: 'not-a-list' }],
    [{ kind: 'ok', status: 500, text: '' }, { kind: 'http', status: 500 }],
    [{ kind: 'ok', status: 0, text: '' }, { kind: 'http', status: 0 }],
    [{ kind: 'timeout' }, { kind: 'timeout' }],
    [{ kind: 'network' }, { kind: 'network' }],
    [expired, { kind: 'expired' }],
  ];
  for (const [answer, stop] of cases) {
    const run = walk({ [key(OTHER, null)]: page([entry(1)], 'B2'), [key(OTHER, 'B2')]: answer });
    const result = await run.result;
    assert.deepEqual({ ids: ids(result.items), complete: result.complete, stop: result.stop }, { ids: [chatId(1)], complete: false, stop }, JSON.stringify(stop));
    assert.equal(run.calls.length, 2, `${JSON.stringify(stop)}: no call after it`);
  }
});

test('a chat listed in both variants at one time is returned once, with the entry the main list gave it', async () => {
  const pinned = listEntry(1, 1700000000);
  const main = [...listEntry(1, 1700000000).slice(0, 9), 0];
  const run = walk({ [key(OTHER, null)]: page([pinned]), [key(MAIN, null)]: page([main, entry(2)]) });
  const result = await run.result;
  assert.deepEqual(ids(result.items), [chatId(1), chatId(2)]);
  assert.deepEqual(result.items[0].entry, main);
});

test('a chat the two lists give at different times is returned once, at the later time', async () => {
  const newer = listEntry(1, 1700000500);
  const older = listEntry(1, 1700000000);
  for (const [first, second] of [[newer, older], [older, newer]]) {
    const run = walk({ [key(OTHER, null)]: page([first]), [key(MAIN, null)]: page([second]) });
    const result = await run.result;
    assert.deepEqual(result.items.map((item) => [item.id, item.endedSec]), [[chatId(1), 1700000500]]);
  }
});

test('every call carries the page token and the request id it was given', async () => {
  const run = walk({ [key(OTHER, null)]: page([entry(1)]), [key(MAIN, null)]: page([entry(2)]) });
  await run.result;
  assert.deepEqual(run.sent, [
    { url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&hl=en&rt=c&_reqid=123456', at: 'TOKEN' },
    { url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&hl=en&rt=c&_reqid=123456', at: 'TOKEN' },
  ]);
});

test('an empty page that carries a new cursor is followed', async () => {
  const run = walk({
    [key(OTHER, null)]: page([], 'B2'),
    [key(OTHER, 'B2')]: page([entry(1)]),
    [key(MAIN, null)]: page([]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'B2', OTHER], [10, null, MAIN]]);
  assert.equal(result.complete, true);
});

test('each list keeps its own cursors, so the main list may use one the other gave', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'X'),
    [key(OTHER, 'X')]: page([entry(2)]),
    [key(MAIN, null)]: page([entry(3)], 'X'),
    [key(MAIN, 'X')]: page([entry(4)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'X', OTHER], [10, null, MAIN], [10, 'X', MAIN]]);
  assert.deepEqual({ ids: ids(result.items), complete: result.complete }, { ids: [chatId(1), chatId(2), chatId(3), chatId(4)], complete: true });
});

test('each list keeps its own seen chats, so the main list repeating the other\'s chats is not stuck', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(2)], 'B3'),
    [key(OTHER, 'B3')]: page([entry(3)]),
    [key(MAIN, null)]: page([entry(1)], 'A2'),
    [key(MAIN, 'A2')]: page([entry(2)], 'A3'),
    [key(MAIN, 'A3')]: page([entry(3)], 'A4'),
    [key(MAIN, 'A4')]: page([entry(4)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls.slice(3), [[10, null, MAIN], [10, 'A2', MAIN], [10, 'A3', MAIN], [10, 'A4', MAIN]]);
  assert.equal(result.complete, true);
});

test('each list counts its own pages with nothing new, so the main list starts afresh', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'B2'),
    [key(OTHER, 'B2')]: page([entry(1)], 'B3'),
    [key(OTHER, 'B3')]: page([entry(1)]),
    [key(MAIN, null)]: page([], 'A2'),
    [key(MAIN, 'A2')]: page([entry(2)]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls.slice(3), [[10, null, MAIN], [10, 'A2', MAIN]]);
  assert.equal(result.complete, true);
});

test('a cursor that comes back after a different one ends that list', async () => {
  const run = walk({
    [key(OTHER, null)]: page([entry(1)], 'A'),
    [key(OTHER, 'A')]: page([entry(2)], 'B'),
    [key(OTHER, 'B')]: page([entry(3)], 'A'),
    [key(MAIN, null)]: page([]),
  });
  const result = await run.result;
  assert.deepEqual(run.calls, [[10, null, OTHER], [10, 'A', OTHER], [10, 'B', OTHER], [10, null, MAIN]]);
  assert.equal(result.complete, false);
});
