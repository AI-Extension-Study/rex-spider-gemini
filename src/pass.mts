// One crawl pass: the page token from the homepage, the chat list, and a
// summary record for each chat in the crawl window whose upload key is not
// stamped yet. Requests, rex-spider's side, the dispatch and the clock are
// handed in, so the pass runs under the unit tests as it does in the worker.
// It never throws: every outcome is a reason.
import type { DateString } from '@bric/rex-types/types';

import { type Client } from './client.mts';
import { uploadKeyId } from './keys.mts';
import { TIMED_OUT, touch, withDeadline } from './pacing.mts';
import { DISABLED, FETCH_SUCCESSFUL, NO_RESULTS, NO_TOKEN, PARTIAL, STORE_SILENT, homepageFailed, homepageUnreachable, listFailed } from './reasons.mts';
import { type GeminiRecord, buildSummaryRecord } from './record.mts';
import { type WalkStop, walkList } from './walk.mts';
import { pageToken } from './wire.mts';

export const HOME_URL = 'https://gemini.google.com/app';

// The rex-spider calls the pass makes. The window check reads the extension's
// storage and the key calls rex-core's store, which never answers while its
// database is not open, so each runs to a deadline. isEnabled is the served
// config as of now, read before each request and each batch.
export interface PassFramework {
  isEnabled(): boolean;
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
}

export const PASS_LIMITS: PassLimits = { settleMs: 3000, batch: 25, storeMs: 20_000 };

export interface PassDeps {
  readonly client: Pick<Client, 'get' | 'postForm'>;
  readonly framework: PassFramework;
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

export async function runPass(deps: PassDeps): Promise<PassOutcome> {
  const { client, framework, limits = PASS_LIMITS, log = (line: string) => console.log(`[rex-spider-gemini] ${line}`) } = deps;
  try {
    // rex-spider checks enabled when it queues the crawl; the served config
    // may have switched the spider off while other spiders ran first.
    if (!framework.isEnabled()) {
      return SWITCHED_OFF;
    }
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
    const unsent: GeminiRecord[] = [];
    const stopsBeforeSending = walk.stop !== null && ['not-a-list', 'timeout', 'network', 'disabled'].includes(walk.stop.kind);
    if (!stopsBeforeSending) {
      for (const item of walk.items) {
        const record = buildSummaryRecord(item);
        if (!(await step(() => framework.crawlWindowContains(record.ended.timestamp()), limits.storeMs, deps.keepAlive, log))) {
          continue;
        }
        crawledIds.push(item.id);
        if (!(await step(() => framework.checkIfAlreadyTransmitted(uploadKeyId(item.id, true), record.ended), limits.storeMs, deps.keepAlive, log))) {
          unsent.push(record);
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
    unsent.sort((a, b) => b.ended.timestamp() - a.ended.timestamp());
    let sent = 0;
    let stampsStopped = false;
    let disabled = false;
    for (let start = 0; start < unsent.length && !stampsStopped; start += limits.batch) {
      if (!framework.isEnabled()) {
        disabled = true;
        break;
      }
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
        // A stamp that fails, or gets no answer, stops the stamping and the
        // sending: records sent from here on could not be stamped either, so
        // none are, and they go out next pass instead of twice. The records
        // already sent stay counted.
        try {
          await step(() => framework.logTransmitted(uploadKeyId(record.identifier, true), record.ended), limits.storeMs, deps.keepAlive, log);
        } catch (error) {
          log(`a stamp ${error instanceof StoreSilent ? 'got no answer' : `failed (${error instanceof Error ? error.name : typeof error})`}; sending stops for this pass`);
          stampsStopped = true;
        }
      }
    }
    // The reason says how the list was read; how much went out is the count.
    // A pass that read the whole list says "Fetch successful." even when its
    // sending stopped early: what it did not send goes out next pass. A
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
    const kind = error instanceof Error ? error.name : typeof error;
    log(`the pass ended on an internal error (${kind})`);
    return failed(listFailed(`internal error (${kind})`));
  }
}
