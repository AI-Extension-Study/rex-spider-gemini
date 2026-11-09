// The Gemini case of the extension's content processor, which calls
// redactGemini for platform 'gemini' on every rex-conversation point before
// it is queued for upload. A record buildSummaryRecord or buildDetailRecord
// made comes back as it went in, with the title at metadata[1] replaced by
// the hash hashTitle gives, each field written from its checked value. Any
// other event keeps only the scaffold: the fields the processor keeps for a
// point of no known platform, each in its form. The case never rejects,
// because rex-content-processing uploads a rejected processor's input
// unredacted. The extension carries a copy of this file, made for the commit
// its lockfile pins, so it imports nothing but rex-types. Pure.
import { DateString } from '@bric/rex-types/types';

const NAME = 'rex-conversation';
const PLATFORM = 'gemini';

// Ids as the list and the read give them: a prefix and lowercase hex. The
// length is left open, so a longer id still reads; hex carries no text.
const CHAT_ID = /^c_[0-9a-f]{8,64}$/;
const RESPONSE_ID = /^r_[0-9a-f]{8,64}$/;
const DRAFT_ID = /^rc_[0-9a-f]{8,64}$/;
const isChatId = (value: unknown): value is string => typeof value === 'string' && CHAT_ID.test(value);
const isResponseId = (value: unknown): value is string => typeof value === 'string' && RESPONSE_ID.test(value);

// The form the scaffold keeps a name, a platform or a generator id in: PDK's
// generator ids and the platform strings are lowercase words joined by
// hyphens, none over 64 characters.
const ID_FORM = /^[a-z][a-z0-9-]{0,63}$/;
const inIdForm = (value: unknown): boolean => typeof value === 'string' && ID_FORM.test(value);

// The fields the content processor keeps for a point of no known platform,
// each with the form the scaffold keeps it in; a field outside its form, or
// undefined, is left out. _pdk_trace_context and passive-data-metadata are
// PDK's own and go as they come.
const SCAFFOLD: Readonly<Record<string, (value: unknown) => boolean>> = {
  date: (value) => typeof value === 'number' && Number.isFinite(value),
  name: inIdForm,
  platform: inIdForm,
  identifier: isChatId,
  generatorId: inIdForm,
  _pdk_trace_context: (value) => value !== undefined,
  'passive-data-metadata': (value) => value !== undefined,
};
const FIELDS = [...Object.keys(SCAFFOLD), 'is_summary', 'turns', 'started', 'ended', 'metadata'];

// The attachment kinds a turn may name: the read parser's (read.mts), and
// 'other' for any other type.
export const ATTACHMENT_KINDS: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'text/plain', 'text/csv', 'other',
]);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// Unix seconds from 2001 to 2286, the range the list and the read are held
// to (time.mts).
const isPlausibleSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1e9 && value < 1e10;

const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
function instantOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !INSTANT_SHAPE.test(value)) {
    return null;
  }
  return new DateString(value).value !== null ? value : null;
}

// A field of the event: an own property, read once, or undefined if reading
// it throws, as a getter or a proxy can.
function readOwn(event: unknown, key: string): unknown {
  try {
    return has(event as object, key) ? (event as Readonly<Record<string, unknown>>)[key] : undefined;
  } catch {
    return undefined;
  }
}

// Temporal.Instant's own toString, taken from a DateString's value so it is
// rex-types' copy of the polyfill. Called on a value through Reflect.apply it
// is the brand check: the polyfill throws a TypeError for anything but one of
// its own instants.
const INSTANT_TO_STRING = (Object.getPrototypeOf(new DateString('1970-01-01T00:00:00Z').value) as { toString(): string }).toString;

const NUMBER_FORM = /^number:(\d+)$/;

// The seconds a started or ended holds, when it is the DateString record.mts
// builds from whole seconds: originalValue 'number:' and those seconds (the
// expected ones, when given), value the same instant as a Temporal.Instant
// of rex-types' copy or as its ISO string, and no other own key; else null,
// or a throw the caller catches. Each field is read once. Only the seconds
// are used: the case writes a new DateString.
function secondsOf(date: unknown, expected: number | null): number | null {
  if (!isObject(date)) {
    return null;
  }
  const keys = Object.keys(date);
  if (keys.length !== 2 || !has(date, 'value') || !has(date, 'originalValue')) {
    return null;
  }
  const { value, originalValue } = date;
  const match = typeof originalValue === 'string' ? NUMBER_FORM.exec(originalValue) : null;
  const seconds = match === null ? null : Number(match[1]);
  if (!isPlausibleSeconds(seconds) || (expected !== null && seconds !== expected)) {
    return null;
  }
  const iso = new DateString(seconds).toJSON();
  const same = typeof value === 'string'
    ? instantOrNull(value) !== null && new DateString(value).toJSON() === iso
    : Reflect.apply(INSTANT_TO_STRING, value, []) === iso;
  return same ? seconds : null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// A list-entry position kept as it is, when it can hold no text: null, a
// flag, a finite number, an id, or a list of numbers such as [seconds,
// nanos]. Anything else is null, so the entry keeps its positions.
function keepPosition(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return CHAT_ID.test(value) || RESPONSE_ID.test(value) || DRAFT_ID.test(value) ? value : null;
  }
  if (Array.isArray(value) && value.every((element) => element === null || (typeof element === 'number' && Number.isFinite(element)))) {
    return [...value];
  }
  return null;
}

async function keepEntry(entry: readonly unknown[], hashTitle: (title: unknown) => Promise<string | null>): Promise<unknown[]> {
  const kept = Array.from(entry, (value, index) => (index === 1 ? null : keepPosition(value)));
  const titleHash = await hashTitle(entry[1]);
  kept[1] = typeof titleHash === 'string' && SHA256_HEX.test(titleHash) ? titleHash : null;
  return kept;
}

// A turn as record.mts writes it, each key in its form; other keys dropped.
function keepTurn(turn: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { identifier, parent, when, drafts, attachments, attachment_types: kinds } = turn;
  return {
    identifier: isResponseId(identifier) ? identifier : null,
    parent: isResponseId(parent) ? parent : null,
    when: instantOrNull(when),
    drafts: isCount(drafts) ? drafts : null,
    attachments: isCount(attachments) ? attachments : null,
    attachment_types: Array.isArray(kinds) ? kinds.map((kind) => (typeof kind === 'string' && ATTACHMENT_KINDS.has(kind) ? kind : 'other')) : [],
  };
}

/** The record for a record record.mts built, else the scaffold; never rejects. */
export async function redactGemini(event: unknown, hashTitle: (title: unknown) => Promise<string | null>): Promise<Record<string, unknown>> {
  const fields = Object.fromEntries(FIELDS.map((key) => [key, readOwn(event, key)]));
  const scaffold = Object.fromEntries(Object.entries(SCAFFOLD).filter(([key, holds]) => holds(fields[key])).map(([key]) => [key, fields[key]]));
  try {
    const { name, platform, identifier, date, is_summary: isSummary, turns, metadata, started } = fields;
    if (name !== NAME || platform !== PLATFORM || !isChatId(identifier) || typeof isSummary !== 'boolean'
      || !Array.isArray(turns) || (isSummary && turns.length !== 0) || !Array.isArray(metadata) || metadata[0] !== identifier) {
      return scaffold;
    }
    // ended is the list entry's last-message time, [seconds, nanos] at [5].
    const time: unknown = metadata[5];
    const listed: unknown = Array.isArray(time) ? time[0] : undefined;
    const endedSec = isPlausibleSeconds(listed) ? secondsOf(fields.ended, listed) : null;
    if (endedSec === null) {
      return scaffold;
    }
    let startedSec: number | null = null;
    if (started !== undefined) {
      // Only a detail record has a start, and it is no later than the end.
      startedSec = isSummary ? null : secondsOf(started, null);
      if (startedSec === null || startedSec > endedSec) {
        return scaffold;
      }
    }
    // date is the record's instant in ms: its start when it has one, else its
    // end, as record.mts writes it.
    if (date !== new DateString(startedSec ?? endedSec).timestamp()) {
      return scaffold;
    }
    return {
      ...scaffold,
      is_summary: isSummary,
      turns: turns.filter((turn) => isObject(turn)).map((turn) => keepTurn(turn)),
      ended: new DateString(endedSec),
      ...(startedSec === null ? {} : { started: new DateString(startedSec) }),
      metadata: await keepEntry(metadata, hashTitle),
    };
  } catch {
    return scaffold;
  }
}
