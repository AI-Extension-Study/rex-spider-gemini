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
  drafts?: number;
  mimes?: string[];
}

function attachment(mime: string): unknown[] {
  return [null, 1, `${MARKER}.png`, `https://example.invalid/${MARKER}`, null, `${MARKER}-token`, null, null, 1, [1700000000, 0], null, mime, null, null, null, []];
}

export function exchange({ chat, response, parent, seconds, drafts = 1, mimes = [] }: ExchangeSpec): unknown[] {
  const files = mimes.map(attachment);
  const prompt = [[`${MARKER} prompt`, null, null, null, [[null, null, null, files.length > 0 ? files : null, files.length > 0 ? files : null]]], 1, null, 1, `${MARKER}-hex`, null, null, null, false, null, []];
  const draftList = Array.from({ length: drafts }, (_, i) => [draftId(response * 10 + i), [`${MARKER} reply`], null, null, null, null, null, null, [], 'en']);
  const reply = [draftList, null, null, draftId(response * 10), null, null, null, null, `${MARKER}-region`, false, null, null, [], null, `${MARKER}-hex`, null, null, `${MARKER}-hex`, null, null, null, `${MARKER} model`, null, null, 6, 1, null, null, null, null, null, `${MARKER}-constant`];
  return [[chat, responseId(response)], parent === undefined ? null : [chat, responseId(parent), draftId(parent * 10)], prompt, reply, [seconds, 457522000]];
}

// A read answer: exchanges newest first, as the server sends them, and a
// cursor in payload[1] when the read was cut.
export function readResponse(exchanges: unknown[][], cursor: string | null = null): string {
  return batchResponse(wrb('hNvQHb', [exchanges, cursor, null, []]));
}
