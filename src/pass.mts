// One crawl pass: the page token from the homepage, the chat list, and a
// summary record for each chat in the crawl window whose upload key is not
// stamped yet. Requests, rex-spider's side, the dispatch and the clock are
// handed in, so the pass runs under the unit tests as it does in the worker.
// It never throws: every outcome is a reason.
import type { DateString } from '@bric/rex-types/types';

import { type Client } from './client.mts';
import { uploadKeyId } from './keys.mts';
import { TIMED_OUT, withDeadline } from './pacing.mts';
import { FETCH_SUCCESSFUL, NO_TOKEN, PARTIAL, homepageFailed, homepageUnreachable, listFailed } from './reasons.mts';
import { type GeminiRecord, buildSummaryRecord } from './record.mts';
import { type WalkStop, walkList } from './walk.mts';
import { pageToken } from './wire.mts';

export const HOME_URL = 'https://gemini.google.com/app';

// The rex-spider calls the pass makes. Each goes to rex-core's store, which
// never answers while its database is not open, so each runs to a deadline.
export interface PassFramework {
  crawlWindowContains(timestamp: number): Promise<boolean>;
  checkIfAlreadyTransmitted(identifier: string, updated: DateString): Promise<boolean>;
  logTransmitted(identifier: string, updated: DateString): Promise<void>;
  fetchCrawlDelay(): number;
}

export interface PassLimits {
  // The wait after a batch of dispatches before their keys are stamped, so
  // the records are stored first: a worker that dies in between sends them
  // again, never loses them.
  readonly settleMs: number;
  readonly batch: number;
  // The longest wait for one store call.
  readonly storeMs: number;
}

export const PASS_LIMITS: PassLimits = { settleMs: 1500, batch: 25, storeMs: 1000 };

// A keep-alive call every this many chats in a loop that makes no request:
// store reads do not reset the worker's idle timer.
const KEEP_ALIVE_EVERY = 100;

export interface PassDeps {
  readonly client: Pick<Client, 'get' | 'postForm'>;
  readonly framework: PassFramework;
  readonly dispatch: (record: GeminiRecord) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly keepAlive: () => void;
  readonly requestId: number;
  readonly limits?: PassLimits;
  readonly log?: (line: string) => void;
}

export interface PassOutcome {
  // Records sent, or -1 when the pass ended in an error.
  readonly crawledCount: number;
  // The chats in the crawl window that were checked.
  readonly crawledIds: string[];
  readonly reason: string;
  // A line for the crawl result's issues, or null.
  readonly issue: string | null;
}

// An error sends nothing: every error stop comes before any chat was checked.
const failed = (reason: string, issue: string = reason): PassOutcome => ({ crawledCount: -1, crawledIds: [], reason, issue });

class StoreSilent extends Error {}

async function step<T>(promise: Promise<T>, ms: number): Promise<T> {
  const answer = await withDeadline(promise, ms);
  if (answer === TIMED_OUT) {
    throw new StoreSilent();
  }
  return answer;
}

// The walk's stop as the outcome this spider has always reported: an error
// sends nothing, except that an HTTP error after chats in the window were
// listed, and an expired session, send what was listed as a partial pass.
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
      return null;
  }
}

export async function runPass(deps: PassDeps): Promise<PassOutcome> {
  const { client, framework, limits = PASS_LIMITS, log = (line: string) => console.log(`[rex-spider-gemini] ${line}`) } = deps;
  try {
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

    const walk = await walkList({ client, sleep: deps.sleep, crawlDelay: () => framework.fetchCrawlDelay(), at, requestId: deps.requestId, log });

    const crawledIds: string[] = [];
    const unsent: GeminiRecord[] = [];
    const stopsBeforeSending = walk.stop !== null && ['not-a-list', 'timeout', 'network'].includes(walk.stop.kind);
    if (!stopsBeforeSending) {
      for (const [index, item] of walk.items.entries()) {
        if (index > 0 && index % KEEP_ALIVE_EVERY === 0) {
          deps.keepAlive();
        }
        const record = buildSummaryRecord(item);
        if (!(await step(framework.crawlWindowContains(record.ended.timestamp()), limits.storeMs))) {
          continue;
        }
        crawledIds.push(item.id);
        if (!(await step(framework.checkIfAlreadyTransmitted(uploadKeyId(item.id, true), record.ended), limits.storeMs))) {
          unsent.push(record);
        }
      }
    }
    if (walk.stop !== null) {
      const reason = stopReason(walk.stop, crawledIds.length);
      if (reason !== null) {
        return failed(reason);
      }
    }

    // Newest first, so a pass cut short has sent the most recent chats.
    unsent.sort((a, b) => b.ended.timestamp() - a.ended.timestamp());
    let sent = 0;
    let stampsStopped = false;
    for (let start = 0; start < unsent.length; start += limits.batch) {
      const batch: GeminiRecord[] = [];
      for (const record of unsent.slice(start, start + limits.batch)) {
        try {
          deps.dispatch(record);
          batch.push(record);
          sent += 1;
        } catch (error) {
          log(`a record could not be dispatched (${error instanceof Error ? error.name : typeof error})`);
        }
      }
      await deps.sleep(limits.settleMs);
      for (const record of batch) {
        if (stampsStopped) {
          break;
        }
        const stamped = await withDeadline(framework.logTransmitted(uploadKeyId(record.identifier, true), record.ended), limits.storeMs);
        if (stamped === TIMED_OUT) {
          log('the store did not answer a stamp; the rest go out again next pass');
          stampsStopped = true;
        }
      }
    }
    const complete = walk.complete && !stampsStopped;
    return { crawledCount: sent, crawledIds, reason: complete ? FETCH_SUCCESSFUL : PARTIAL, issue: null };
  } catch (error) {
    if (error instanceof StoreSilent) {
      return failed(listFailed('the store did not answer'));
    }
    return failed(listFailed(`internal error (${error instanceof Error ? error.name : typeof error})`));
  }
}
