// The rex-conversation records the spider sends. Pure.
//
// A summary record is the record this spider has always sent, built from the
// list entry alone, with is_summary true. A detail record has every field of
// the summary record, so code that reads one reads the other, and adds the
// chat's start and one content-free object per exchange under turns. The
// metadata of both is the raw list entry: its title is hashed by the
// extension that bundles this module.
import { DateString } from '@bric/rex-types/types';

import { type ListItem, toConversation } from './list.mts';
import { type Exchange, type ReadResult } from './read.mts';

export interface GeminiTurn {
  readonly identifier: string;
  readonly parent: string | null;
  // The exchange's time as an ISO instant, to the nanosecond the read gives.
  readonly when: string;
  readonly drafts: number | null;
  readonly attachments: number;
  readonly attachment_types: readonly string[];
}

export interface GeminiRecord {
  readonly name: 'rex-conversation';
  readonly is_summary: boolean;
  // Epoch ms: the last message for a summary record, the start for a detail
  // record whose start is known, as the other REX spiders' records do.
  readonly date: number;
  readonly identifier: string;
  readonly turns: readonly GeminiTurn[];
  readonly platform: string;
  readonly ended: DateString;
  readonly started?: DateString;
  readonly metadata: readonly unknown[];
}

export function buildSummaryRecord(item: ListItem): GeminiRecord {
  const conversation = toConversation(item);
  const ended = conversation.ended as DateString;
  return {
    name: 'rex-conversation',
    is_summary: true,
    date: ended.timestamp(),
    identifier: conversation.identifier,
    turns: [],
    platform: conversation.platform,
    ended,
    metadata: item.entry,
  };
}

// An exact instant from whole seconds and nanoseconds; a float of seconds
// would round the nanoseconds.
function instant(exchange: Exchange): DateString {
  const whole = new Date(exchange.whenSec * 1000).toISOString().slice(0, 19);
  return new DateString(`${whole}.${String(exchange.whenNanos).padStart(9, '0')}Z`);
}

const turnOf = (exchange: Exchange): GeminiTurn => ({
  identifier: exchange.responseId,
  parent: exchange.parentId,
  when: instant(exchange).toJSON(),
  drafts: exchange.drafts,
  attachments: exchange.attachmentTypes.length,
  attachment_types: [...exchange.attachmentTypes],
});

// started is set only when the read came back whole, since otherwise the
// oldest exchange may be missing. It is whole seconds, as ended is (the
// upload key is built from ended), so a chat never starts after it ends; the
// nanoseconds stay in each turn's when, so the newest turn's when can be up
// to a second past ended. The read sends exchanges newest first: reversed
// before the stable sort, two exchanges with one time keep their order, a
// reply after the prompt it answers.
export function buildDetailRecord(item: ListItem, read: Extract<ReadResult, { kind: 'read' }>): GeminiRecord {
  const summary = buildSummaryRecord(item);
  const oldestFirst = [...read.exchanges].reverse().sort((a, b) => a.whenSec - b.whenSec || a.whenNanos - b.whenNanos);
  const started = read.whole && oldestFirst.length > 0 ? new DateString(oldestFirst[0].whenSec) : undefined;
  return {
    ...summary,
    is_summary: false,
    date: (started ?? summary.ended).timestamp(),
    turns: oldestFirst.map(turnOf),
    ...(started === undefined ? {} : { started }),
  };
}
