// One chat read, the hNvQHb RPC, reduced to what a record may carry: per
// exchange its response id, the draft its prompt followed, the draft shown
// for its reply, its time, how many drafts the reply had, the kinds of any
// files attached to the prompt, and counts of the prompt's and the shown
// reply's text, citations and search results. The prompt and the shown reply
// are read only to be counted (count.mts); no text, file name, URL, token or
// other string of the payload leaves this module. Pure.
//
// The positions come from structure captures of real reads (shapes, string
// forms and counts only): an exchange is [[chat id, response id], parent or
// null, prompt, reply, [seconds, nanos]]; the parent is [chat id, previous
// response id, previous shown draft id]; the prompt's text is prompt[0][0]
// and its files are the list at prompt[0][4][0][3], each entry with its MIME
// type at [11] (prompt[0][4][0][4] lists the same files again); the reply's
// drafts are reply[0], and the id of the one shown is reply[3]. A draft is
// [id, [text], citations, ...], with its thoughts and tool calls at [37].
// Exchanges come newest first, and a read cut short carries a cursor in
// payload[1].
import { type TextCounts, citationCount, countText, searchResultCount, withoutPlaceholderLinks } from './count.mts';
import { isPlausibleSeconds } from './time.mts';
import { rpcFrames } from './wire.mts';

export const READ_RPC = 'hNvQHb';

// Exchanges asked for in one read. A chat with more comes back cut, and its
// record then carries the newest READ_COUNT and no start time.
export const READ_COUNT = 200;

export function readArgs(chatId: string): unknown[] {
  return [chatId, READ_COUNT, null, 1, [0], [4], null, 1];
}

const RESPONSE_ID = /^r_[0-9a-f]{16}$/;
const DRAFT_ID = /^rc_[0-9a-f]{16}$/;
const draftIdOrNull = (value: unknown): string | null => (typeof value === 'string' && DRAFT_ID.test(value) ? value : null);

// The attachment kinds a record may name; any other MIME type is 'other',
// since a type string is not checked further than this list.
export const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'text/plain', 'text/csv',
]);

export interface ReplyCounts {
  readonly text: TextCounts | null;
  readonly citations: number | null;
  readonly searchResults: number | null;
}

export interface Exchange {
  readonly responseId: string;
  // The draft Gemini says the prompt followed: the previous exchange's shown
  // reply. Null on the first exchange, or in another form.
  readonly parentDraftId: string | null;
  // The draft shown for the reply; null in another form.
  readonly shownDraftId: string | null;
  readonly whenSec: number;
  readonly whenNanos: number;
  // Null when the reply has no draft list where one is expected.
  readonly drafts: number | null;
  // Null when the prompt's file list has another form: the files are unknown.
  readonly attachmentTypes: readonly string[] | null;
  // Null when the prompt's text is not a string.
  readonly prompt: TextCounts | null;
  // Every count null when no draft has the shown id: the reply is unknown.
  readonly reply: ReplyCounts;
}

export type ReadResult =
  // whole is false when a cursor says the chat has older exchanges than
  // these, or when an exchange could not be read: either way the oldest
  // exchange may be missing.
  | { readonly kind: 'read'; readonly exchanges: Exchange[]; readonly whole: boolean; readonly skipped: number }
  | { readonly kind: 'error'; readonly code: number | null }
  | { readonly kind: 'not-a-read' };

const at = (value: unknown, ...path: number[]): unknown => path.reduce<unknown>((node, index) => (Array.isArray(node) ? node[index] : undefined), value);

// The kinds of the files attached to a prompt, from the list at
// prompt[0][4][0][3]. None when a level of that path is null or absent: a
// text-only prompt has an empty holder, or none at all (2 of 10 chats in the
// third capture). Null when the prompt block is missing, or a level or a file
// entry has another form, so a changed layout reads as unknown, not as no
// files.
function attachmentTypes(prompt: unknown): string[] | null {
  const block = at(prompt, 0);
  if (!Array.isArray(block)) {
    return null;
  }
  let level: unknown = block;
  for (const index of [4, 0, 3]) {
    level = (level as unknown[])[index];
    if (level === null || level === undefined) {
      return [];
    }
    if (!Array.isArray(level)) {
      return null;
    }
  }
  const files = level as unknown[];
  if (!files.every((file) => Array.isArray(file))) {
    return null;
  }
  // An entry whose type string is missing or moved still counts, as other.
  return files.map((file) => {
    const mime = at(file, 11);
    return typeof mime === 'string' && ATTACHMENT_TYPES.has(mime) ? mime : 'other';
  });
}

// The shown draft's counts. Its text is counted without placeholder links;
// its thoughts, its tool results and the other drafts are not text.
function replyCounts(drafts: unknown, shown: unknown): ReplyCounts {
  // Found by the id as it is, so a draft id of a new length still gives its
  // counts; only the id a record reports is held to the rc_ form.
  const draft: unknown = typeof shown !== 'string' || !Array.isArray(drafts) ? undefined : drafts.find((candidate) => at(candidate, 0) === shown);
  if (draft === undefined) {
    return { text: null, citations: null, searchResults: null };
  }
  const text = at(draft, 1, 0);
  return {
    text: typeof text === 'string' ? countText(withoutPlaceholderLinks(text)) : null,
    citations: citationCount(draft),
    searchResults: searchResultCount(draft),
  };
}

function readExchange(value: unknown, chatId: string): Exchange | null {
  const responseId = at(value, 0, 1);
  const whenSec = at(value, 4, 0);
  if (at(value, 0, 0) !== chatId || typeof responseId !== 'string' || !RESPONSE_ID.test(responseId) || !isPlausibleSeconds(whenSec)) {
    return null;
  }
  const nanos = at(value, 4, 1);
  const drafts = at(value, 3, 0);
  const shown = at(value, 3, 3);
  const prompt = at(value, 2, 0, 0);
  return {
    responseId,
    parentDraftId: draftIdOrNull(at(value, 1, 2)),
    shownDraftId: draftIdOrNull(shown),
    whenSec,
    whenNanos: Number.isInteger(nanos) && (nanos as number) >= 0 && (nanos as number) < 1e9 ? (nanos as number) : 0,
    drafts: Array.isArray(drafts) ? drafts.length : null,
    attachmentTypes: attachmentTypes(at(value, 2)),
    prompt: typeof prompt === 'string' ? countText(prompt) : null,
    reply: replyCounts(drafts, shown),
  };
}

// The read of chatId. An exchange that is not of that chat, lacks a response
// id or a plausible time, or repeats a response id is skipped and counted. A
// read that gives no exchange at all is an error, not a chat with nothing in
// it: a record built from it would be sent and never read again.
export function parseRead(body: string, chatId: string): ReadResult {
  const frames = rpcFrames(body, READ_RPC);
  if (frames === null || frames.length === 0) {
    return { kind: 'not-a-read' };
  }
  const frame = frames[0];
  if (frame.kind === 'error') {
    return frame;
  }
  const payload = frame.value;
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return { kind: 'error', code: null };
  }
  const exchanges: Exchange[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const value of payload[0]) {
    const exchange = readExchange(value, chatId);
    if (exchange === null || seen.has(exchange.responseId)) {
      skipped += 1;
    } else {
      seen.add(exchange.responseId);
      exchanges.push(exchange);
    }
  }
  if (exchanges.length === 0) {
    return { kind: 'error', code: null };
  }
  const cursor = payload[1];
  const cut = cursor !== null && cursor !== undefined && cursor !== '';
  return { kind: 'read', exchanges, whole: !cut && skipped === 0, skipped };
}
