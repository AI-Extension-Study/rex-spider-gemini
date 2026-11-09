// One chat read, the hNvQHb RPC, reduced to what a record may carry: per
// exchange its response id, its parent, its time, how many drafts the reply
// had, and the kinds of any files attached to the prompt. Prompt and reply
// text, file names, URLs, tokens and every other string in the payload are
// never read out of it. Pure.
//
// The positions come from structure captures of real reads (shapes and string
// forms only): an exchange is [[chat id, response id], parent or null,
// prompt, reply, [seconds, nanos]]; the parent is [chat id, previous response
// id, previous draft id]; the reply's drafts are reply[0]; the prompt's files
// are the list at prompt[0][4][0][3], each entry with its MIME type at [11]
// (seen for one pasted image only). Exchanges come newest first, and a read
// cut short carries a cursor in payload[1].
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

// The attachment kinds a record may name; any other MIME type is 'other',
// since a type string is not checked further than this list.
export const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'text/plain', 'text/csv',
]);

export interface Exchange {
  readonly responseId: string;
  readonly parentId: string | null;
  readonly whenSec: number;
  readonly whenNanos: number;
  // Null when the reply has no draft list where one is expected.
  readonly drafts: number | null;
  readonly attachmentTypes: readonly string[];
}

export type ReadResult =
  // whole is false when a cursor says the chat has older exchanges than
  // these, or when an exchange could not be read: either way the oldest
  // exchange may be missing.
  | { readonly kind: 'read'; readonly exchanges: Exchange[]; readonly whole: boolean; readonly skipped: number }
  | { readonly kind: 'error'; readonly code: number | null }
  | { readonly kind: 'not-a-read' };

const at = (value: unknown, ...path: number[]): unknown => path.reduce<unknown>((node, index) => (Array.isArray(node) ? node[index] : undefined), value);

function attachmentTypes(files: unknown): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  // An entry whose type string is missing or moved still counts, as other.
  return files.filter((file) => Array.isArray(file)).map((file) => {
    const mime = at(file, 11);
    return typeof mime === 'string' && ATTACHMENT_TYPES.has(mime) ? mime : 'other';
  });
}

function readExchange(value: unknown, chatId: string): Exchange | null {
  const responseId = at(value, 0, 1);
  const whenSec = at(value, 4, 0);
  if (at(value, 0, 0) !== chatId || typeof responseId !== 'string' || !RESPONSE_ID.test(responseId) || !isPlausibleSeconds(whenSec)) {
    return null;
  }
  const nanos = at(value, 4, 1);
  const parentId = at(value, 1, 1);
  const drafts = at(value, 3, 0);
  return {
    responseId,
    parentId: typeof parentId === 'string' && RESPONSE_ID.test(parentId) ? parentId : null,
    whenSec,
    whenNanos: Number.isInteger(nanos) && (nanos as number) >= 0 && (nanos as number) < 1e9 ? (nanos as number) : 0,
    drafts: Array.isArray(drafts) ? drafts.length : null,
    attachmentTypes: attachmentTypes(at(value, 2, 0, 4, 0, 3)),
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
