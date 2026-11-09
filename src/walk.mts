// The chat-list walk: the spider's two list calls, each followed page by page
// through its next-page cursor, crawl_delay apart. Requests and waits are
// handed in, so the walk runs under the unit tests as it does in the worker.
import { type Client } from './client.mts';
import { LIST_RPC, type ListItem, parseListPage } from './list.mts';
import { bardErrorCodes, batchBody, batchUrl } from './wire.mts';

export const PAGE_SIZE = 10;

// A list still handing out new cursors after this many pages is cut, so a
// server that never stops paging cannot hold a crawl. 1,000 pages of 10 chats
// is far past any account seen.
export const MAX_PAGES = 1000;

// A list whose pages bring no chat it had not given, this many in a row, is
// cut: its paging is not moving on. One such page can be ordinary (chats that
// move up between two calls shift a page), so it takes three.
export const STALE_PAGES = 3;

// The two list calls, in the order the spider has always made them.
const VARIANTS: readonly (readonly unknown[])[] = [[1, null, 1], [0, null, 1]];

export type WalkStop =
  | { readonly kind: 'not-a-list' }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'expired' }
  // The served config switched the spider off during the walk.
  | { readonly kind: 'disabled' };

export interface WalkResult {
  // Each chat once, in the order first listed. A chat both lists give
  // carries the entry with the later last-message time, and on a tie the
  // entry of the list walked last, [0,null,1].
  readonly items: ListItem[];
  // False when any answer was read only in part: an error frame, a skipped
  // entry, a list cut for not moving on or at maxPages, or a stop.
  readonly complete: boolean;
  // What ended the walk early, or null when it made every call it meant to.
  readonly stop: WalkStop | null;
}

export interface WalkDeps {
  readonly client: Pick<Client, 'postForm'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly crawlDelay: () => number;
  readonly at: string;
  readonly requestId: number;
  readonly maxPages?: number;
  // Read before each list call; false stops the walk there.
  readonly enabled?: () => boolean;
  readonly log?: (line: string) => void;
}

const defaultLog = (line: string) => console.log(`[rex-spider-gemini] ${line}`);

export async function walkList({ client, sleep, crawlDelay, at, requestId, maxPages = MAX_PAGES, enabled = () => true, log = defaultLog }: WalkDeps): Promise<WalkResult> {
  const url = batchUrl(LIST_RPC, requestId);
  const items = new Map<string, ListItem>();
  let complete = true;
  let calls = 0;
  const result = (stop: WalkStop | null): WalkResult => ({ items: [...items.values()], complete: complete && stop === null, stop });
  for (const variant of VARIANTS) {
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let stale = 0;
    for (let pages = 1; ; pages += 1) {
      if (calls > 0) {
        await sleep(crawlDelay());
      }
      if (!enabled()) {
        return result({ kind: 'disabled' });
      }
      calls += 1;
      const answer = await client.postForm(url, batchBody(LIST_RPC, [PAGE_SIZE, cursor, variant], at));
      if (answer.kind !== 'ok') {
        return result({ kind: answer.kind });
      }
      if (answer.status < 200 || answer.status > 299) {
        return result({ kind: 'http', status: answer.status });
      }
      if (bardErrorCodes(answer.text).includes(1096)) {
        return result({ kind: 'expired' });
      }
      const page = parseListPage(answer.text);
      if (page.kind === 'not-a-list') {
        return result({ kind: 'not-a-list' });
      }
      // A failed list call is not an empty account: this list ends here and
      // the walk goes on to the next one.
      if (page.kind === 'error') {
        log(`a conversation list call answered with an error (code ${page.code})`);
        complete = false;
        break;
      }
      if (page.skipped > 0) {
        log(`skipped ${page.skipped} conversation list entries without a chat id in its form or a time`);
        complete = false;
      }
      let fresh = 0;
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          fresh += 1;
        }
        const kept = items.get(item.id);
        if (kept === undefined || item.endedSec >= kept.endedSec) {
          items.set(item.id, item);
        }
      }
      // Entries the parser skipped still show the paging moved on.
      stale = fresh === 0 && page.skipped === 0 ? stale + 1 : 0;
      if (page.next === null) {
        break;
      }
      // A cursor this list gave before, or pages that keep bringing nothing
      // new, mean the paging is not moving on; following it would never end.
      if (cursors.has(page.next) || stale >= STALE_PAGES || pages >= maxPages) {
        log('a conversation list stopped moving on or ran past its page limit; it was cut there');
        complete = false;
        break;
      }
      cursors.add(page.next);
      cursor = page.next;
    }
  }
  return result(null);
}
