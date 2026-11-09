// One page of the chat list, the MaZiqc RPC. Pure.
import { type Conversation, DateString } from '@bric/rex-types/types';

import { rpcFrames } from './wire.mts';

export const LIST_RPC = 'MaZiqc';

export interface ListItem {
  readonly id: string;
  // entry[5][0], the last message's time in whole seconds. The upload key is
  // built from this value alone, nanoseconds (entry[5][1]) left out, so keys
  // written by earlier builds of this module still match.
  readonly endedSec: number;
  // The raw entry, which the record carries as its metadata.
  readonly entry: readonly unknown[];
}

export type ListPage =
  | { readonly kind: 'page'; readonly items: ListItem[]; readonly next: string | null; readonly skipped: number }
  | { readonly kind: 'error'; readonly code: number | null }
  | { readonly kind: 'not-a-list' };

function readItem(chat: unknown): ListItem | null {
  if (!Array.isArray(chat) || typeof chat[0] !== 'string' || chat[0] === '') {
    return null;
  }
  const time = chat[5];
  if (!Array.isArray(time) || typeof time[0] !== 'number' || !Number.isFinite(time[0])) {
    return null;
  }
  return { id: chat[0], endedSec: time[0], entry: chat };
}

// A page's payload is [?, next-page token, [entry, ...]]. A null payload, or
// one whose entry slot is absent or null, is a page with no chats; anything
// else in either place is an error, not an empty account. An entry this
// cannot read is skipped and counted, so one odd chat does not cost the page;
// the caller decides what a count above zero means for the pass.
export function parseListPage(body: string): ListPage {
  const frames = rpcFrames(body, LIST_RPC);
  if (frames === null || frames.length === 0) {
    return { kind: 'not-a-list' };
  }
  const frame = frames[0];
  if (frame.kind === 'error') {
    return frame;
  }
  const payload = frame.value;
  if (payload === null) {
    return { kind: 'page', items: [], next: null, skipped: 0 };
  }
  const chats: unknown = Array.isArray(payload) ? payload[2] : undefined;
  if (!Array.isArray(payload) || (chats !== undefined && chats !== null && !Array.isArray(chats))) {
    return { kind: 'error', code: null };
  }
  const items: ListItem[] = [];
  let skipped = 0;
  for (const chat of Array.isArray(chats) ? chats : []) {
    const item = readItem(chat);
    if (item === null) {
      skipped += 1;
    } else {
      items.push(item);
    }
  }
  // The token is only read from a payload that also has the entry slot.
  const token = payload.length > 2 ? payload[1] : null;
  return { kind: 'page', items, next: typeof token === 'string' && token !== '' ? token : null, skipped };
}

// The record fields a list item gives. `ended` comes from the whole seconds
// alone: rex-spider's upload key is the chat id and this instant in
// milliseconds, so it stays the key earlier builds of this module wrote.
export function toConversation(item: ListItem): Conversation {
  return { identifier: item.id, turns: [], platform: 'gemini', ended: new DateString(item.endedSec), metadata: item.entry };
}
