// The account record (rex-account), the layout the AI crawlers share for
// account settings, and when it is read and sent. Its format_version is the
// data format the pass runs under (format.mts). Gemini fills one key,
// history_saved, from Gemini Apps Activity: the site's ESY5D call with
// [null,[5]] answers [[null,null,null,null,<bool>]]. No source was found for
// the other standard keys, so they are null. Pure but for the hash, which is
// the SHA-256 of crypto.subtle, in the service worker as under Node.
import { rpcFrames } from './wire.mts';

export const ACCOUNT_RPC = 'ESY5D';
export const ACCOUNT_ARGS: readonly unknown[] = [null, [5]];

export interface AccountRecord {
  readonly name: 'rex-account';
  readonly platform: 'gemini';
  readonly format_version: number;
  // Epoch ms of the read.
  readonly date: number;
  readonly plan: string | null;
  readonly paid: boolean | null;
  readonly workspace: 'personal' | 'team' | 'enterprise' | 'edu' | null;
  readonly web_search_enabled: boolean | null;
  readonly training_allowed: boolean | null;
  readonly history_saved: boolean | null;
  readonly memory_enabled: boolean | null;
  readonly custom_instructions_set: boolean | null;
  readonly account_created: string | null;
  // Each source's HTTP status, -1 for no answer.
  readonly source_status: Readonly<Record<string, number>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// The served `account` block. rex-spider merges a spider's block over the
// default one key by key, so a gemini block's `account` replaces the
// default's whole.
export interface AccountSettings {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
}

// What is stored after each read (store.mts): the hash of the record last
// sent ('' before any), and when it was sent and when the account was last
// read, in epoch ms (0 for never sent).
export interface AccountState {
  readonly hash: string;
  readonly sentAt: number;
  readonly readAt: number;
}

const DEFAULT_INTERVAL_MINUTES = 60;
const MINUTE_MS = 60_000;
// A stored read or send further ahead than this means the clock moved back,
// and the account is read, or its record sent, again rather than waiting for
// the clock to catch up.
const CLOCK_MOVED_MS = 5 * MINUTE_MS;
// An unchanged record is sent again after a day, so a day with no record
// means the account could not be read, not that nothing changed.
const RESEND_MS = 24 * 60 * MINUTE_MS;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function accountSettings(block: unknown): AccountSettings {
  const served = isRecord(block) ? block : {};
  const interval = served.interval_minutes;
  return {
    enabled: served.enabled === true,
    intervalMinutes: Number.isInteger(interval) && (interval as number) >= 15 && (interval as number) <= 1440 ? (interval as number) : DEFAULT_INTERVAL_MINUTES,
  };
}

export function isAccountState(value: unknown): value is AccountState {
  return isRecord(value) && typeof value.hash === 'string' && (value.hash === '' || SHA256_HEX.test(value.hash)) && isTime(value.sentAt) && isTime(value.readAt);
}

export function accountDue(state: AccountState | null, now: number, intervalMinutes: number): boolean {
  return state === null || state.readAt - now > CLOCK_MOVED_MS || now - state.readAt >= intervalMinutes * MINUTE_MS;
}

export function shouldSend(state: AccountState | null, hash: string, now: number): boolean {
  return state === null || state.hash !== hash || now - state.sentAt >= RESEND_MS || state.sentAt - now > CLOCK_MOVED_MS;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
  }
  return value;
}

// SHA-256 hex of the record without its date, keys sorted at every level, so
// two reads of the same settings hash alike. format_version is hashed, so the
// first read under a new data format sends its record.
export async function accountHash(record: AccountRecord): Promise<string> {
  const undated: Record<string, unknown> = { ...record };
  delete undated.date;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(sortedKeys(undated))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Gemini Apps Activity from an ESY5D answer: the flag when the body holds one
// ESY5D frame whose payload is exactly [[null,null,null,null,<bool>]], else
// null. An error frame (an expired session gives one), a page without the
// batchexecute guard and a reshaped payload are all null, never a setting.
export function parseActivity(body: string): boolean | null {
  const frames = rpcFrames(body, ACCOUNT_RPC);
  if (frames === null || frames.length !== 1 || frames[0].kind !== 'payload') {
    return null;
  }
  const { value } = frames[0];
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const [slots] = value;
  if (!Array.isArray(slots) || slots.length !== 5 || slots.slice(0, 4).some((slot) => slot !== null)) {
    return null;
  }
  return typeof slots[4] === 'boolean' ? slots[4] : null;
}

export function buildGeminiAccount(status: number, historySaved: boolean | null, now: number, format: number): AccountRecord {
  return {
    name: 'rex-account',
    platform: 'gemini',
    format_version: format,
    date: now,
    plan: null,
    paid: null,
    workspace: null,
    web_search_enabled: null,
    training_allowed: null,
    history_saved: typeof historySaved === 'boolean' ? historySaved : null,
    memory_enabled: null,
    custom_instructions_set: null,
    account_created: null,
    source_status: { [ACCOUNT_RPC]: Number.isInteger(status) ? status : -1 },
    metadata: {},
  };
}
