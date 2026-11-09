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
import { resendSince, sentAlready } from './mode.mts';
import { TIMED_OUT, touch, withDeadline } from './pacing.mts';
import { READ_RPC, type ReadResult, parseRead, readArgs } from './read.mts';
import { DISABLED, FETCH_SUCCESSFUL, NO_RESULTS, NO_TOKEN, PARTIAL, STORE_SILENT, homepageFailed, homepageUnreachable, listFailed } from './reasons.mts';
import { type GeminiRecord, buildDetailRecord, buildSummaryRecord } from './record.mts';
import { type GeminiStore, type Mode } from './store.mts';
import { type WalkStop, walkList } from './walk.mts';
import { bardErrorCodes, batchBody, batchUrl, pageToken } from './wire.mts';

export const HOME_URL = 'https://gemini.google.com/app';

// The rex-spider calls the pass makes. The window check reads the extension's
// storage and the key calls rex-core's store, which never answers while its
// database is not open, so each runs to a deadline. isEnabled is the served
// config as of now, read before each request and each batch; justSummarize
// is the served mode, read once per pass.
export interface PassFramework {
  isEnabled(): boolean;
  justSummarize(): boolean;
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
  // The longest the detail reads of one pass may take, waits included.
  // rex-spider runs its spiders one at a time, so a pass with hundreds of
  // chats to read would hold the others back for hours. The chats it does not
  // reach keep no key and are read in a later pass.
  readonly detailBudgetMs: number;
}

export const PASS_LIMITS: PassLimits = { settleMs: 3000, batch: 25, storeMs: 20_000, detailBudgetMs: 360_000 };

export interface PassDeps {
  readonly client: Pick<Client, 'get' | 'postForm'>;
  readonly framework: PassFramework;
  // rex-core's store, for the mode record (mode.mts).
  readonly store: Pick<GeminiStore, 'mode'>;
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
      return { sent, disabled: true };
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
        return { sent, disabled: false };
      }
    }
  }
  return { sent, disabled: false };
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

// Detail mode: each chat read in turn, crawl_delay apart and never closer
// than the settle wait, until the detail budget is spent. The floor keeps a
// served crawl_delay of 0, or one that is not a number, from firing reads
// back to back. A record's key is stamped after the wait before the next
// read, or after a settle wait at the end. A failed read sends and stamps
// nothing for its chat, so a later pass reads it again.
async function sendDetails(ctx: Sending, items: readonly ListItem[]): Promise<Sent> {
  const { deps, limits, log } = ctx;
  const { client, framework } = deps;
  const started = deps.now();
  let sent = 0;
  // The record sent last, its key not stamped yet.
  let unstamped: GeminiRecord | null = null;
  for (const item of items) {
    if (deps.now() - started >= limits.detailBudgetMs) {
      log('the detail budget is spent; the chats not read are read in a later pass');
      break;
    }
    await deps.sleep(Math.max(paceMs(framework), limits.settleMs));
    if (unstamped !== null) {
      const record: GeminiRecord = unstamped;
      unstamped = null;
      if (!(await stamped(ctx, record))) {
        return { sent, disabled: false };
      }
    }
    if (!framework.isEnabled()) {
      return { sent, disabled: true };
    }
    const answer = await client.postForm(batchUrl(READ_RPC, deps.requestId), batchBody(READ_RPC, readArgs(item.id), ctx.at));
    const read = answer.kind === 'ok' && answer.status >= 200 && answer.status <= 299 ? parseRead(answer.text, item.id) : null;
    if (read !== null && read.kind === 'read') {
      const record = buildDetailRecord(item, read);
      if (dispatched(ctx, record)) {
        sent += 1;
        unstamped = record;
      }
      continue;
    }
    if (answer.kind === 'ok' && bardErrorCodes(answer.text).includes(1096)) {
      log('the session expired during the detail reads; the chats not read are read in a later pass');
      break;
    }
    log(`a detail read failed (${readFailure(answer, read)})`);
  }
  if (unstamped !== null) {
    await deps.sleep(limits.settleMs);
    await stamped(ctx, unstamped);
  }
  return { sent, disabled: false };
}

export async function runPass(deps: PassDeps): Promise<PassOutcome> {
  const { client, framework, limits = PASS_LIMITS, log = (line: string) => console.log(`[rex-spider-gemini] ${line}`) } = deps;
  try {
    // rex-spider checks enabled when it queues the crawl; the served config
    // may have switched the spider off while other spiders ran first.
    if (!framework.isEnabled()) {
      return SWITCHED_OFF;
    }
    // Read once: a config refresh during the pass applies from the next one.
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
    const { sent, disabled } = served === 'summary'
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
