// Every rex-core key this module writes. They sit under the namespace
// rex-spider gives the spider, next to the two keys rex-spider writes itself:
// rex-spider-gemini-last-crawl, and the upload key
// rex-spider-gemini-conversation-upload-<id>-<ms>, which rex-spider builds
// from the id below and the record's last-message time.
import { FIRST_DATA_FORMAT, isDataFormat } from './format.mts';

export const KEY_PREFIX = 'rex-spider-gemini-';

function chatIdOrThrow(chatId: string): string {
  if (typeof chatId !== 'string' || chatId === '') {
    throw new TypeError('a chat id must be a non-empty string');
  }
  return chatId;
}

// A key or key id as format 1 writes it, or with -f and the format for a
// later one. A format that is not one is a caller's bug and throws, so no key
// is written for it.
function withFormat(id: string, format: number): string {
  if (!isDataFormat(format)) {
    throw new TypeError('a data format must be a whole number from 1 to 999');
  }
  return format === FIRST_DATA_FORMAT ? id : `${id}-f${format}`;
}

// The id an upload key is built from, one per mode and data format
// (format.mts), so a chat sent in one mode is unsent in the other, and a chat
// sent under one format is unsent under another. Format 1 keeps the ids
// earlier builds of this module wrote: the bare chat id in summary mode, so
// an update sends nothing again there, and -detail in detail mode. A later
// format adds -f and its number to either.
export function uploadKeyId(chatId: string, summary: boolean, format: number): string {
  const id = summary ? chatIdOrThrow(chatId) : `${chatIdOrThrow(chatId)}-detail`;
  return withFormat(id, format);
}

// The served mode and when this browser first saw it (store.mts, ModeRecord).
export const MODE_KEY = `${KEY_PREFIX}mode`;

// The account read's state (store.mts, AccountState).
export const ACCOUNT_KEY = `${KEY_PREFIX}account`;

const MEMO_PREFIX = `${KEY_PREFIX}detail-memo-`;

// One chat's memo of a failed detail read (store.mts, DetailMemo), per data
// format as the upload keys are, so a memo written under one format does not
// hold the chat back under another. Format 1 keeps the key earlier builds
// wrote.
export function memoKey(chatId: string, format: number): string {
  return withFormat(`${MEMO_PREFIX}${chatIdOrThrow(chatId)}`, format);
}

// The part of a key that may be logged: its kind. A memo key carries a chat
// id, and a key this module does not own is not echoed at all.
export function keyKind(key: string): string {
  if (key === MODE_KEY || key === ACCOUNT_KEY) {
    return key;
  }
  if (key.startsWith(MEMO_PREFIX)) {
    return `${KEY_PREFIX}detail-memo`;
  }
  return 'other key';
}
