// One crawl pass: the page token from the homepage, the chat list, and a
// record for each chat in the crawl window that is not sent yet in the served
// mode. Summary mode sends the list entry; detail mode reads the chat first.
// Requests, rex-spider's side, the store, the dispatch and the clock are
// handed in, so the pass runs under the unit tests as it does in the worker.
// It never throws: every outcome is a reason.
import type { DateString } from '@bric/rex-types/types';

import { type Answer, type Client } from './client.mts';
import { uploadKeyId } from './keys.mts';
import { type ListItem } from './list.mts';
import { CLOCK_SKEW_MS, resendSince, sentAlready } from './mode.mts';
import { TIMED_OUT, touch, withDeadline } from './pacing.mts';
import { READ_RPC, type ReadResult, parseRead, readArgs } from './read.mts';
import { DETAIL_FAILED, DISABLED, FETCH_SUCCESSFUL, NO_RESULTS, NO_TOKEN, PARTIAL, SERVER_WAIT, STORE_SILENT, homepageFailed, homepageUnreachable, listFailed } from './reasons.mts';
import { type GeminiRecord, buildDetailRecord, buildSummaryRecord } from './record.mts';
import { type DetailMemo, type GeminiStore, type Mode } from './store.mts';
import { type WalkStop, walkList } from './walk.mts';
import { bardErrorCodes, batchBody, batchUrl, pageToken } from './wire.mts';

export const HOME_URL = 'https://gemini.google.com/app';

// The rex-spider calls the pass makes. The window check reads the extension's
// storage and the key calls rex-core's store, which never answers while its
// database is not open, so each runs to a deadline. isEnabled is the served
// config as of now, read before each request and each batch. justSummarize
// is the served mode, read when the pass starts and again before each detail
// read, since a detail pass can run for hours. continueAfterError is the
// served halt_on_error, false for true, read at each failed detail read.
export interface PassFramework {
  isEnabled(): boolean;
  justSummarize(): boolean;
  continueAfterError(): boolean;
  crawlWindowContains(timestamp: number): Promise<boolean>;
  checkIfAlreadyTransmitted(identifier: string, updated: DateString): Promise<boolean>;
  logTransmitted(identifier: string, updated: DateString): Promise<void>;
  fetchCrawlDelay(): number;
}

export interface PassLimits {
  // The wait after a batch of dispatches before their keys are stamped. It
  // stands in for a signal rex-core's dispatchEvent does not give: when a
  // point is stored. The extension that bundles this module stores points a
  // little over a second after the last one (a trailing timer of 1.1 s, then
  // one write per point), so 3 s leaves room for 25 records. A worker that
  // dies before the stamps sends those records again rather than losing
  // them. A point the extension drops before storing it (its processing has
  // no error path) is lost all the same, and this module cannot see that.
  readonly settleMs: number;
  readonly batch: number;
  // The longest wait for one window check, key read or stamp. Long enough
  // that only storage that is not answering trips it, as the other REX
  // spiders' passes allow.
  readonly storeMs: number;
  // The reading time the detail reads of one pass may take: requests,
  // parsing and store calls. The paced waits between reads do not count. On
  // the wall clock, at the 30 s crawl_delay, the budget would end a pass at
  // about 12 reads, and the first detail sweep of a heavy account would take
  // many passes with a sleep_delay between each. Counted this way, the sweep
  // runs as one pass (90 chats take about 45 minutes of waits), and since
  // rex-spider runs its spiders one at a time, the others wait until it ends.
  // The project's other crawlers count their budget the same way. The chats
  // a pass does not reach keep no key and are read in a later pass.
  readonly detailBudgetMs: number;
  // Failed detail reads in a row that end a pass's reads when halt_on_error
  // is false: past a few, the reads are failing for a reason the next chats
  // share.
  readonly failedRun: number;
}

export const PASS_LIMITS: PassLimits = { settleMs: 3000, batch: 25, storeMs: 20_000, detailBudgetMs: 360_000, failedRun: 3 };

export interface PassDeps {
  readonly client: Pick<Client, 'get' | 'postForm'>;
  readonly framework: PassFramework;
  // rex-core's store, for the mode record (mode.mts) and the memos of
  // failed detail reads.
  readonly store: Pick<GeminiStore, 'mode' | 'memo'>;
  // Epoch ms.
  readonly now: () => number;
  readonly dispatch: (record: GeminiRecord) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly keepAlive: () => unknown;
  readonly requestId: number;
  readonly limits?: PassLimits;
  readonly log?: (line: string) => void;
}

export interface PassOutcome {
  // Records sent, or -1 when the pass has no reading of the list: it ended in
  // an error, or was switched off before the list was read. Readers of the
  // completion event take a count of 0 or more to mean crawledIds is such a
  // reading, so an empty list there would read as an emptied account.
  readonly crawledCount: number;
  // The chats in the crawl window that were checked.
  readonly crawledIds: string[];
  readonly reason: string;
  // A line for the crawl result's issues, or null.
  readonly issue: string | null;
}

// An error sends nothing: every error stop comes before any chat was checked.
const failed = (reason: string, issue: string = reason): PassOutcome => ({ crawledCount: -1, crawledIds: [], reason, issue });

// A switch-off before the list was read: no reading, and not an issue.
const SWITCHED_OFF: PassOutcome = { crawledCount: -1, crawledIds: [], reason: DISABLED, issue: null };

class StoreSilent extends Error {}

// One store call to its deadline, after a keep-alive call: store calls do
// not reset the worker's idle timer, and one may take most of the deadline.
// touch() makes the call without waiting on it and logs a failed one.
async function step<T>(call: () => Promise<T>, ms: number, keepAlive: () => unknown, log: (line: string) => void): Promise<T> {
  touch(keepAlive, log);
  const answer = await withDeadline(call(), ms);
  if (answer === TIMED_OUT) {
    throw new StoreSilent();
  }
  return answer;
}

// The walk's stop as the outcome this spider has always reported: an error
// sends nothing, except that an HTTP error or an expired session after chats
// in the window were listed send those, as a partial pass. Before any was
// listed they are errors too, with no reading.
function stopReason(stop: WalkStop, inWindow: number): string | null {
  switch (stop.kind) {
    case 'not-a-list':
      return listFailed('Received invalid response for conversation API');
    case 'timeout':
    case 'network':
      return listFailed(`Unable to crawl the conversation list (${stop.kind})`);
    case 'http':
      return inWindow === 0 ? listFailed(`List fetch failed (status ${stop.status})`) : null;
    case 'expired':
      return inWindow === 0 ? listFailed('Session expired') : null;
    case 'disabled':
      return DISABLED;
  }
}

// What the sending of a pass shares.
interface Sending {
  readonly deps: PassDeps;
  readonly limits: PassLimits;
  readonly log: (line: string) => void;
  // The page token.
  readonly at: string;
}

interface Sent {
  readonly sent: number;
  readonly disabled: boolean;
  // Why failed reads ended the reads early, if they did: they kept failing,
  // or the server asked to wait.
  readonly stopped: 'failed' | 'wait' | null;
}

const kindOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);

function dispatched(ctx: Sending, record: GeminiRecord): boolean {
  try {
    ctx.deps.dispatch(record);
    return true;
  } catch (error) {
    ctx.log(`a record could not be dispatched (${kindOf(error)})`);
    return false;
  }
}

// Stamps a sent record's key, in the record's own mode, and reads it back:
// rex-spider's logTransmitted resolves whatever the store answers, a failed
// write included. A stamp that fails, is not kept, or gets no answer stops
// the stamping and the sending for the pass: the store is failing, and a
// silent one would hold each further stamp for its whole deadline. A record
// sent but not stamped, the rest of a summary batch included, goes out again
// in a later pass, so none is lost. The records already sent stay counted.
async function stamped(ctx: Sending, record: GeminiRecord): Promise<boolean> {
  const { framework, keepAlive } = ctx.deps;
  const id = uploadKeyId(record.identifier, record.is_summary);
  try {
    await step(() => framework.logTransmitted(id, record.ended), ctx.limits.storeMs, keepAlive, ctx.log);
    if (!(await step(() => framework.checkIfAlreadyTransmitted(id, record.ended), ctx.limits.storeMs, keepAlive, ctx.log))) {
      ctx.log('a stamp was not kept; sending stops for this pass');
      return false;
    }
    return true;
  } catch (error) {
    ctx.log(`a stamp ${error instanceof StoreSilent ? 'got no answer' : `failed (${kindOf(error)})`}; sending stops for this pass`);
    return false;
  }
}

// Summary mode: the records in batches, each batch's keys stamped after the
// settle wait that follows it.
async function sendSummaries(ctx: Sending, records: readonly GeminiRecord[]): Promise<Sent> {
  let sent = 0;
  for (let start = 0; start < records.length; start += ctx.limits.batch) {
    if (!ctx.deps.framework.isEnabled()) {
      return { sent, disabled: true, stopped: null };
    }
    const batch: GeminiRecord[] = [];
    for (const record of records.slice(start, start + ctx.limits.batch)) {
      if (dispatched(ctx, record)) {
        batch.push(record);
      }
    }
    sent += batch.length;
    await ctx.deps.sleep(ctx.limits.settleMs);
    for (const record of batch) {
      if (!(await stamped(ctx, record))) {
        return { sent, disabled: false, stopped: null };
      }
    }
  }
  return { sent, disabled: false, stopped: null };
}

// crawl_delay as a wait. A value that is not a positive number is no wait, as
// a bare timer takes it; the reads still keep the settle wait between them.
function paceMs(framework: PassFramework): number {
  const delay = Number(framework.fetchCrawlDelay());
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

// What went wrong with a read, for the log, never the answer's text.
function readFailure(answer: Answer, read: Exclude<ReadResult, { kind: 'read' }> | null): string {
  if (answer.kind !== 'ok') {
    return answer.kind;
  }
  if (read === null) {
    return `status ${answer.status}`;
  }
  return read.kind === 'error' ? `error frame, code ${read.code}` : 'not a read';
}

const DAY_MS = 24 * 60 * 60 * 1000;

// When a chat whose read failed is read again: a day after a first failure
// that may pass by itself (no answer, or a 5xx), a week after any other or a
// repeat. A chat with a newer last message is read at once.
export const RETRY_SOON_MS = DAY_MS;
export const RETRY_LATE_MS = 7 * DAY_MS;

// A write that waits for the wait before the next read, as a stamp waits for
// its record to be stored: a detail record's stamp, or the memo of a failed
// read, whose summary record may have just gone out.
type Pending =
  | { readonly kind: 'stamp'; readonly record: GeminiRecord }
  | { readonly kind: 'memo'; readonly chatId: string; readonly memo: DetailMemo };

// A memo that is not kept stops the sending, as a stamp does: next pass would
// read the chat again at once and send its summary again.
async function memoKept(ctx: Sending, chatId: string, memo: DetailMemo): Promise<boolean> {
  touch(ctx.deps.keepAlive, ctx.log);
  const answer = await ctx.deps.store.memo.set(chatId, memo);
  if (!answer.ok) {
    ctx.log('a detail memo was not kept; sending stops for this pass');
  }
  return answer.ok;
}

const written = (ctx: Sending, due: Pending): Promise<boolean> => (due.kind === 'stamp' ? stamped(ctx, due.record) : memoKept(ctx, due.chatId, due.memo));

// Detail mode: each chat read in turn, crawl_delay apart and never closer
// than the settle wait, until the reads have spent the detail budget, which
// leaves out the waits between them. The floor keeps a served crawl_delay of
// 0, or one that is not a number, from firing reads back to back. A record's
// key, or a failed read's memo, is written after the wait before the next
// read, or after a settle wait at the end.
//
// A failed read sends the chat's summary record in the detail's place, once
// per last message, and writes a memo that holds the chat back until its
// retry time. The summary's key is not stamped: a chat last used before the
// re-send window would then count as sent in detail (mode.mts), and its
// retry would never come. With halt_on_error the first failed read ends the
// reads; without, failedRun of them in a row do, repeats included, so a read
// that fails for every chat stops early even when most have memos. A chat
// held back by its memo neither counts nor resets the run. halt_on_error is
// read at each failed read, so a refresh that turns it on applies at the next.
//
// A rate limit (429) or an overloaded server (503) fails the read as one that
// may pass, and also ends the reads, since the server asked to wait: under a
// rate limit, one read per pass, and every chat still gets its summary. An
// expired session ends the reads with no memo: it is not the chat's failure.
// Summary mode served during the reads ends them too: the next pass sends in
// summary, and the records already sent keep the keys they went out under.
async function sendDetails(ctx: Sending, items: readonly ListItem[]): Promise<Sent> {
  const { deps, limits, log } = ctx;
  const { client, framework, store } = deps;
  const started = deps.now();
  // The time spent in the waits between reads, which the budget leaves out.
  let waited = 0;
  let sent = 0;
  let failedInARow = 0;
  let stopped: 'failed' | 'wait' | null = null;
  let pending: Pending | null = null;
  for (const item of items) {
    if (deps.now() - started - waited >= limits.detailBudgetMs) {
      log('the detail budget is spent; the chats not read are read in a later pass');
      break;
    }
    const endedMs = item.endedSec * 1000;
    touch(deps.keepAlive, log);
    const memo = await store.memo.get(item.id);
    if (memo.unanswered) {
      log('a detail memo got no answer; its chat is read in a later pass');
      continue;
    }
    const earlier = memo.value !== null && memo.value.ended === endedMs ? memo.value : null;
    // A memo from a clock that ran fast is not trusted, as the mode record's
    // start is not (mode.mts).
    if (earlier !== null && earlier.at <= deps.now() + CLOCK_SKEW_MS && deps.now() < earlier.at + earlier.retryMs) {
      continue;
    }
    // Measured on the clock rather than taken as the wait asked for, so a
    // timer that fires late, or a clock change during the wait, does not
    // count as reading either.
    const waitFrom = deps.now();
    await deps.sleep(Math.max(paceMs(framework), limits.settleMs));
    waited += deps.now() - waitFrom;
    if (pending !== null) {
      const due: Pending = pending;
      pending = null;
      if (!(await written(ctx, due))) {
        return { sent, disabled: false, stopped: null };
      }
    }
    if (!framework.isEnabled()) {
      return { sent, disabled: true, stopped: null };
    }
    if (framework.justSummarize()) {
      log('summary mode was served during the detail reads; a later pass sends the chats not read');
      break;
    }
    const answer = await client.postForm(batchUrl(READ_RPC, deps.requestId), batchBody(READ_RPC, readArgs(item.id), ctx.at));
    const read = answer.kind === 'ok' && answer.status >= 200 && answer.status <= 299 ? parseRead(answer.text, item.id) : null;
    if (read !== null && read.kind === 'read') {
      failedInARow = 0;
      if (memo.value !== null || memo.malformed) {
        touch(deps.keepAlive, log);
        await store.memo.clear(item.id);
      }
      const record = buildDetailRecord(item, read);
      if (dispatched(ctx, record)) {
        sent += 1;
        pending = { kind: 'stamp', record };
      }
      continue;
    }
    if (answer.kind === 'ok' && bardErrorCodes(answer.text).includes(1096)) {
      log('the session expired during the detail reads; the chats not read are read in a later pass');
      break;
    }
    log(`a detail read failed (${readFailure(answer, read)})`);
    failedInARow += 1;
    const failures = (earlier?.failures ?? 0) + 1;
    let memoDue = true;
    if (failures === 1) {
      const summary = buildSummaryRecord(item);
      let sentBefore: boolean;
      try {
        sentBefore = await step(() => framework.checkIfAlreadyTransmitted(uploadKeyId(item.id, true), summary.ended), limits.storeMs, deps.keepAlive, log);
      } catch (error) {
        log(`a key read ${error instanceof StoreSilent ? 'got no answer' : `failed (${kindOf(error)})`}; sending stops for this pass`);
        return { sent, disabled: false, stopped: null };
      }
      if (!sentBefore) {
        if (dispatched(ctx, summary)) {
          sent += 1;
        } else {
          // No memo, so a later pass reads the chat at once and sends the
          // summary then. A memo now would make each later failure a repeat,
          // and this last message would never be sent.
          memoDue = false;
        }
      }
    }
    const asksToWait = answer.kind === 'ok' && (answer.status === 429 || answer.status === 503);
    if (memoDue) {
      const mayPass = answer.kind !== 'ok' || answer.status >= 500 || asksToWait;
      pending = { kind: 'memo', chatId: item.id, memo: { ended: endedMs, at: deps.now(), retryMs: mayPass && failures === 1 ? RETRY_SOON_MS : RETRY_LATE_MS, failures } };
    }
    if (asksToWait) {
      log('the server asked to wait; the chats not read are read in a later pass');
      stopped = 'wait';
      break;
    }
    const halts = !framework.continueAfterError();
    if (halts || failedInARow >= limits.failedRun) {
      log(halts ? 'a detail read failed and halt_on_error is set; the reads stop' : `${failedInARow} detail reads failed in a row; the reads stop`);
      stopped = 'failed';
      break;
    }
  }
  if (pending !== null) {
    await deps.sleep(limits.settleMs);
    await written(ctx, pending);
  }
  return { sent, disabled: false, stopped };
}

export async function runPass(deps: PassDeps): Promise<PassOutcome> {
  const { client, framework, limits = PASS_LIMITS, log = (line: string) => console.log(`[rex-spider-gemini] ${line}`) } = deps;
  try {
    // rex-spider checks enabled when it queues the crawl; the served config
    // may have switched the spider off while other spiders ran first.
    if (!framework.isEnabled()) {
      return SWITCHED_OFF;
    }
    // The mode this pass sends in. Summary served during the detail reads
    // ends them (sendDetails); any other change applies from the next pass.
    const served: Mode = framework.justSummarize() ? 'summary' : 'detail';
    // When this browser started running the served mode, recorded now if it
    // had not run it before (mode.mts). Each store call follows a keep-alive
    // call, as every store call of a pass does.
    const since = await resendSince({
      mode: {
        get: () => {
          touch(deps.keepAlive, log);
          return deps.store.mode.get();
        },
        set: (record) => {
          touch(deps.keepAlive, log);
          return deps.store.mode.set(record);
        },
      },
    }, served, deps.now());

    const home = await client.get(HOME_URL);
    if (home.kind !== 'ok') {
      return failed(homepageUnreachable(home.kind));
    }
    if (home.status < 200 || home.status > 299) {
      return failed(homepageFailed(home.status), `Unable to fetch ${HOME_URL}. Status code = ${home.status}.`);
    }
    const at = pageToken(home.text);
    if (at === null) {
      return failed(NO_TOKEN);
    }

    const walk = await walkList({ client, sleep: deps.sleep, crawlDelay: () => framework.fetchCrawlDelay(), at, requestId: deps.requestId, enabled: () => framework.isEnabled(), log });

    const crawledIds: string[] = [];
    const unsent: ListItem[] = [];
    const transmitted = (id: string, ended: DateString) => step(() => framework.checkIfAlreadyTransmitted(id, ended), limits.storeMs, deps.keepAlive, log);
    const stopsBeforeSending = walk.stop !== null && ['not-a-list', 'timeout', 'network', 'disabled'].includes(walk.stop.kind);
    if (!stopsBeforeSending) {
      for (const item of walk.items) {
        const { ended } = buildSummaryRecord(item);
        if (!(await step(() => framework.crawlWindowContains(ended.timestamp()), limits.storeMs, deps.keepAlive, log))) {
          continue;
        }
        crawledIds.push(item.id);
        if (!(await sentAlready(item.id, ended, served, since, transmitted))) {
          unsent.push(item);
        }
      }
    }
    if (walk.stop !== null) {
      const reason = stopReason(walk.stop, crawledIds.length);
      if (reason === DISABLED) {
        return SWITCHED_OFF;
      }
      if (reason !== null) {
        return failed(reason);
      }
    }
    if (!walk.complete && crawledIds.length === 0) {
      return failed(NO_RESULTS);
    }

    // Newest first, so a pass cut short has sent the most recent chats.
    unsent.sort((a, b) => b.endedSec - a.endedSec);
    const ctx: Sending = { deps, limits, log, at };
    const { sent, disabled, stopped } = served === 'summary'
      ? await sendSummaries(ctx, unsent.map((item) => buildSummaryRecord(item)))
      : await sendDetails(ctx, unsent);
    // The reason says how the list was read; how much went out is the count.
    // A pass that read the whole list says "Fetch successful." even when its
    // sending stopped early: what it did not send goes out in a later pass. A
    // switch-off says so instead, whatever was read, so nothing counts a pass
    // the config stopped as a full listing.
    if (disabled) {
      return { crawledCount: sent, crawledIds, reason: DISABLED, issue: null };
    }
    // Reads ended by failures say so too: the list was read, but the chats
    // in it were not, and a reader of the data should see that. A list read
    // only in part says so first, since the ids are then not the whole list.
    if (stopped !== null) {
      const why = stopped === 'wait' ? SERVER_WAIT : DETAIL_FAILED;
      return { crawledCount: sent, crawledIds, reason: walk.complete ? why : PARTIAL, issue: why };
    }
    return { crawledCount: sent, crawledIds, reason: walk.complete ? FETCH_SUCCESSFUL : PARTIAL, issue: null };
  } catch (error) {
    if (error instanceof StoreSilent) {
      return failed(STORE_SILENT);
    }
    const kind = kindOf(error);
    log(`the pass ended on an internal error (${kind})`);
    return failed(listFailed(`internal error (${kind})`));
  }
}
