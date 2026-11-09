import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { DateString } from '@bric/rex-types/types';

import { type ListItem } from '../../src/list.mts';
import { ATTACHMENT_TYPES, parseRead } from '../../src/read.mts';
import { type GeminiRecord, buildDetailRecord, buildSummaryRecord } from '../../src/record.mts';
import { ATTACHMENT_KINDS, redactGemini } from '../../src/redact.mts';
import { chatId } from './batch.mts';
import { MARKER, draftId, exchange, readResponse } from './exchanges.mts';

const T = 1700000000;
const hash = async (title: unknown) => (typeof title === 'string' && title !== '' ? createHash('sha256').update(title).digest('hex') : null);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// A list entry in the 22-position layout the structure capture showed: id,
// title, [seconds, nanos] at [5], a flag at [9], the chosen draft's id at [21].
function entry(n: number, seconds = T): unknown[] {
  const positions: unknown[] = Array.from({ length: 22 }, () => null);
  positions[0] = chatId(n);
  positions[1] = `Title ${n}`;
  positions[5] = [seconds, 457522000];
  positions[9] = 1;
  positions[21] = draftId(n);
  return positions;
}

const item = (n: number, seconds = T): ListItem => ({ id: chatId(n), endedSec: seconds, entry: entry(n, seconds) });

function detail(n: number, cursor: string | null = null): GeminiRecord {
  const read = parseRead(readResponse([
    exchange({ chat: chatId(n), response: 2, parent: 1, seconds: T - 60, drafts: 2, mimes: ['image/png', 'application/x-unknown'] }),
    exchange({ chat: chatId(n), response: 1, seconds: T - 120 }),
  ], cursor), chatId(n));
  assert.equal(read.kind, 'read', 'Test setup invalid: the read did not parse');
  return buildDetailRecord(item(n), read as Extract<typeof read, { kind: 'read' }>);
}

// What the record should come back as: itself, with the title's hash.
async function hashed(record: GeminiRecord) {
  const expected = plain(record);
  expected.metadata[1] = await hash(`Title ${record.identifier === chatId(2) ? 2 : 1}`);
  return expected;
}

test('a summary record comes back as it went in, with the title replaced by its hash', async () => {
  const record = buildSummaryRecord(item(1));
  const out = await redactGemini(record, hash);
  assert.deepEqual(plain(out), await hashed(record));
  assert.ok(out.ended instanceof DateString, 'ended is not written as a DateString');
});

test('a detail record comes back as it went in, with the title replaced by its hash', async () => {
  const record = detail(1);
  assert.ok(record.started !== undefined && record.turns.length === 2, 'Test setup invalid: no start or no turns');
  const out = await redactGemini(record, hash);
  assert.deepEqual(plain(out), await hashed(record));
  assert.ok(out.started instanceof DateString, 'started is not written as a DateString');
});

test('a detail record from a read that was cut, with no start, comes back as it went in', async () => {
  const record = detail(2, 'more');
  assert.equal('started' in record, false, 'Test setup invalid: a cut read gave a start');
  assert.deepEqual(plain(await redactGemini(record, hash)), await hashed(record));
});

test('no text gets through: an extra key, or text in a turn field or a list position, is dropped', async () => {
  const record = detail(1) as unknown as Record<string, unknown> & { turns: Record<string, unknown>[]; metadata: unknown[] };
  const metadata = [...record.metadata];
  metadata[2] = `c_${MARKER}`;
  metadata[3] = MARKER;
  metadata[4] = { text: MARKER };
  metadata[6] = [MARKER];
  metadata[7] = [[1, 2]];
  const loaded = {
    ...record,
    title: MARKER,
    extra: { text: MARKER },
    turns: record.turns.map((turn) => ({ ...turn, text: MARKER, when: MARKER, attachment_types: [MARKER, 'image/png'] })),
    metadata,
  };
  const out = await redactGemini(loaded, hash);
  assert.equal(JSON.stringify(out).includes(MARKER), false, JSON.stringify(out));
  assert.equal(out.is_summary, false, 'a record with extra text was not kept as a record');
  const turns = out.turns as Record<string, unknown>[];
  assert.deepEqual(Object.keys(turns[0]), ['identifier', 'parent', 'when', 'drafts', 'attachments', 'attachment_types']);
  assert.deepEqual([turns[0].when, turns[0].attachment_types], [null, ['other', 'image/png']]);
  assert.deepEqual((out.metadata as unknown[]).slice(2, 8), [null, null, null, [T, 457522000], null, null]);
});

test('a point that is not a record this module builds keeps only the scaffold', async () => {
  const summary = buildSummaryRecord(item(1));
  const scaffold = { name: 'rex-conversation', platform: 'gemini', identifier: chatId(1), date: T * 1000 };
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['another name', { ...summary, name: 'rex-other' }, { ...scaffold, name: 'rex-other' }],
    ['another platform', { ...summary, platform: 'chatgpt' }, { ...scaffold, platform: 'chatgpt' }],
    ['an identifier that is not a chat id', { ...summary, identifier: 'chat one' }, { name: 'rex-conversation', platform: 'gemini', date: T * 1000 }],
    ['no is_summary', { ...summary, is_summary: undefined }, scaffold],
    ['turns that are not a list', { ...summary, turns: {} }, scaffold],
    ['a summary with a turn', { ...summary, turns: [{ identifier: 'r_0000000000000001' }] }, scaffold],
    ['no metadata', { ...summary, metadata: undefined }, scaffold],
    ['metadata of another chat', { ...summary, metadata: entry(2) }, scaffold],
    ['ended at another time than the list entry', { ...summary, ended: new DateString(T + 1) }, scaffold],
    ['ended as a string', { ...summary, ended: '2023-11-14T22:13:20Z' }, scaffold],
    ['ended from an ISO string', { ...summary, ended: new DateString('2023-11-14T22:13:20Z') }, scaffold],
    ['a date that is not the record\'s', { ...summary, date: T * 1000 + 1 }, { ...scaffold, date: T * 1000 + 1 }],
    ['a start on a summary', { ...summary, started: new DateString(T - 60) }, scaffold],
  ];
  const record = detail(1);
  cases.push(['a start after the end', { ...record, started: new DateString(T + 60), date: (T + 60) * 1000 }, { ...scaffold, date: (T + 60) * 1000 }]);
  for (const [what, event, expected] of cases) {
    assert.deepEqual(plain(await redactGemini(event, hash)), expected, what);
  }
});

test('the scaffold keeps each field only in its form', async () => {
  const event = { name: 'Rex Conversation', platform: 'gemini', identifier: MARKER, date: 'today', generatorId: 'gen-1', _pdk_trace_context: { id: 1 }, 'passive-data-metadata': { source: 2 }, title: MARKER };
  assert.deepEqual(await redactGemini(event, hash), { platform: 'gemini', generatorId: 'gen-1', _pdk_trace_context: { id: 1 }, 'passive-data-metadata': { source: 2 } });
});

test('a record keeps the PDK fields it came with', async () => {
  const record = { ...buildSummaryRecord(item(1)), generatorId: 'gemini-spider', _pdk_trace_context: { id: 1 }, 'passive-data-metadata': { source: 2 } };
  const out = await redactGemini(record, hash);
  assert.deepEqual([out.generatorId, out._pdk_trace_context, out['passive-data-metadata'], out.is_summary], ['gemini-spider', { id: 1 }, { source: 2 }, true]);
});

test('it never rejects: a field that throws, a hash that rejects, or something that is not an object gives the scaffold', async () => {
  const record = buildSummaryRecord(item(1));
  const throwing = { ...record };
  Object.defineProperty(throwing, 'metadata', { enumerable: true, get: () => { throw new Error(MARKER); } });
  const proxy = new Proxy({ ...record }, { get: () => { throw new Error(MARKER); } });
  const scaffold = { name: 'rex-conversation', platform: 'gemini', identifier: chatId(1), date: T * 1000 };
  assert.deepEqual(plain(await redactGemini(throwing, hash)), scaffold, 'a throwing getter');
  assert.deepEqual(plain(await redactGemini(record, async () => { throw new Error(MARKER); })), scaffold, 'a rejecting hash');
  assert.deepEqual(await redactGemini(proxy, hash), {}, 'a proxy that throws');
  for (const value of [null, undefined, 42, MARKER]) {
    assert.deepEqual(await redactGemini(value, hash), {}, String(value));
  }
});

test('a title hash that is not a SHA-256 hex digest is kept as null', async () => {
  for (const bad of [async () => MARKER, async () => null, async () => 'ABCDEF'.repeat(11).slice(0, 64)]) {
    const out = await redactGemini(buildSummaryRecord(item(1)), bad);
    assert.equal((out.metadata as unknown[])[1], null);
  }
});

test('a DateString whose instant is held as its ISO string still reads as the record\'s', async () => {
  const record = buildSummaryRecord(item(1));
  const out = await redactGemini({ ...record, ended: { value: '2023-11-14T22:13:20Z', originalValue: `number:${T}` } }, hash);
  assert.equal(out.is_summary, true);
});

test('the attachment kinds a turn may name are the read parser\'s, and other', () => {
  assert.deepEqual([...ATTACHMENT_KINDS].sort(), [...ATTACHMENT_TYPES, 'other'].sort());
});
