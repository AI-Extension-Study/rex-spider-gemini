// Builds hNvQHb read payloads for the unit tests in the layout a structure
// capture of real reads showed (positions only; every value here is made up).
// Each slot that holds text, a file name, a URL, a token or an account-wide
// constant gets a MARKER string, so a test can check none reaches a record.
import { batchResponse, wrb } from './batch.mts';

export const MARKER = 'MARKER-do-not-keep';

export const responseId = (n: number) => `r_${n.toString(16).padStart(16, '0')}`;
export const draftId = (n: number) => `rc_${n.toString(16).padStart(16, '0')}`;

export interface ExchangeSpec {
  chat: string;
  response: number;
  parent?: number;
  seconds: number;
  nanos?: number;
  drafts?: number;
  mimes?: string[];
  // The prompt's text slot, [2][0][0].
  prompt?: unknown;
  // The draft shown for the reply (its index in [3][0]), its text, its
  // citation slot [2] and its thoughts-and-tools slot [37]. A plain chat's
  // draft has no [37] at all.
  shown?: number;
  reply?: unknown;
  citations?: unknown;
  tools?: unknown;
}

function attachment(mime: string): unknown[] {
  return [null, 1, `${MARKER}.png`, `https://example.invalid/${MARKER}`, null, `${MARKER}-token`, null, null, 1, [1700000000, 0], null, mime, null, null, null, []];
}

function draft(id: string, text: unknown, citations: unknown, tools: unknown): unknown[] {
  const out: unknown[] = [id, [text], citations, null, null, null, null, null, [], 'en'];
  if (tools !== undefined) {
    while (out.length < 37) out.push(null);
    out.push(tools);
  }
  return out;
}

export function exchange({
  chat, response, parent, seconds, nanos = 457522000, drafts = 1, mimes = [],
  prompt = `${MARKER} prompt`, shown = 0, reply = `${MARKER} reply`, citations = null, tools,
}: ExchangeSpec): unknown[] {
  const files = mimes.map(attachment);
  const promptBlock = [[prompt, null, null, null, [[null, null, null, files.length > 0 ? files : null, files.length > 0 ? files : null]]], 1, null, 1, `${MARKER}-hex`, null, null, null, false, null, []];
  const draftList = Array.from({ length: drafts }, (_, i) => (i === shown
    ? draft(draftId(response * 10 + i), reply, citations, tools)
    : draft(draftId(response * 10 + i), `${MARKER} other draft`, citationSlot(4), toolSlot([5]))));
  const replyBlock = [draftList, null, null, draftId(response * 10 + shown), null, null, null, null, `${MARKER}-region`, false, null, null, [], null, `${MARKER}-hex`, null, null, `${MARKER}-hex`, null, null, null, `${MARKER} model`, null, null, 6, 1, null, null, null, null, null, `${MARKER}-constant`];
  return [[chat, responseId(response)], parent === undefined ? null : [chat, responseId(parent), draftId(parent * 10)], promptBlock, replyBlock, [seconds, nanos]];
}

// A draft's citation slot in the captured layout: [_, entries], one entry per
// cited passage, [[passage, _, _, [[start, end], [start, end]]], [1], [[url,
// title]], id].
export function citationSlot(entries: number): unknown[] {
  return [null, Array.from({ length: entries }, (_, i) => [
    [`${MARKER} passage`, null, null, [[0, 10], [0, 10]]], [1], [[`https://example.invalid/${MARKER}`, `${MARKER} source`]], `${MARKER}-cite-${i}`,
  ])];
}

// A draft's thoughts-and-tools slot: [[thoughts], calls]. A number is a call
// with that many results at [7], as a web search's; null is a call with no
// result list, as a map lookup's.
export function toolSlot(calls: (number | null)[], thoughts = ''): unknown[] {
  return [[thoughts], calls.map((results) => {
    const call: unknown[] = [[''], `${MARKER}-a`, `${MARKER} tool`, `https://example.invalid/${MARKER}-icon`, [], `${MARKER}-b`, ''];
    if (results !== null) {
      call.push(Array.from({ length: results }, () => [`https://example.invalid/${MARKER}-1`, `https://example.invalid/${MARKER}-2`, `${MARKER} title`, null, []]));
    }
    return call;
  })];
}

// A read answer: exchanges newest first, as the server sends them, and a
// cursor in payload[1] when the read was cut.
export function readResponse(exchanges: unknown[][], cursor: string | null = null): string {
  return batchResponse(wrb('hNvQHb', [exchanges, cursor, null, []]));
}
