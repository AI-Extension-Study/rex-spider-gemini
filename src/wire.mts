// The batchexecute envelope gemini.google.com's web app uses for its RPCs:
// a form POST whose f.req names the RPC and carries its arguments as a JSON
// string, answered with a )]}' guard and length-prefixed lines of JSON. Pure:
// no fetch, no chrome.* and no browser globals, so it runs under the unit
// tests as it does in the service worker.

export const BATCH_URL = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';

const GUARD = ")]}'";

export function batchUrl(rpcid: string, requestId: number): string {
  return `${BATCH_URL}?rpcids=${rpcid}&hl=en&rt=c&_reqid=${requestId}`;
}

// `at` is the page token the homepage carries as SNlM0e.
export function batchBody(rpcid: string, args: unknown, at: string): URLSearchParams {
  return new URLSearchParams({ 'f.req': JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]), at });
}

// One RPC's answer. A failed RPC still answers HTTP 200: its frame has no
// payload string, and its status code sits in slot 5. A payload string that is
// not JSON is an error too, with no code, so neither reads as an empty answer.
export type Frame =
  | { readonly kind: 'payload'; readonly value: unknown }
  | { readonly kind: 'error'; readonly code: number | null };

function readFrame(message: readonly unknown[]): Frame {
  const slot = message[2];
  if (typeof slot === 'string') {
    try {
      return { kind: 'payload', value: JSON.parse(slot) };
    } catch {
      return { kind: 'error', code: null };
    }
  }
  const status = message[5];
  return { kind: 'error', code: Array.isArray(status) && Number.isInteger(status[0]) ? (status[0] as number) : null };
}

// The frames for `rpcid`, in the order they came. Null when the body lacks the
// guard, as an HTML page (a sign-in page, an error page) does; an empty list
// when the response holds no frame for the RPC. A line that is not JSON is
// skipped, since the length lines between chunks are not.
export function rpcFrames(body: string, rpcid: string): Frame[] | null {
  if (typeof body !== 'string' || !body.startsWith(GUARD)) {
    return null;
  }
  const frames: Frame[] = [];
  for (const line of body.slice(GUARD.length).split(/\r?\n/)) {
    if (!line.startsWith('[[')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    for (const message of parsed) {
      if (Array.isArray(message) && message[0] === 'wrb.fr' && message[1] === rpcid) {
        frames.push(readFrame(message));
      }
    }
  }
  return frames;
}

const BARD_ERROR = /"type\.googleapis\.com\/assistant\.boq\.bard\.application\.BardErrorInfo",\[(\d+)\]/g;

// The codes of every BardErrorInfo the response carries, in order. 1096 comes
// with an expired session.
export function bardErrorCodes(body: string): number[] {
  return typeof body === 'string' ? [...body.matchAll(BARD_ERROR)].map((match) => Number(match[1])) : [];
}
