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
  // The exchange's time as an ISO instant, written as the record's own
  // started and ended are.
  readonly when: string;
  readonly drafts: number;
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

const turnOf = (exchange: Exchange): GeminiTurn => ({
  identifier: exchange.responseId,
  parent: exchange.parentId,
  when: new DateString(exchange.whenSec).toJSON(),
  drafts: exchange.drafts,
  attachments: exchange.attachmentTypes.length,
  attachment_types: [...exchange.attachmentTypes],
});

// A record for a read that gave at least one exchange; the caller treats a
// read that gave none as a failed one. started is set only when the read came
// back whole, since a cut read lacks the oldest exchanges.
export function buildDetailRecord(item: ListItem, read: Extract<ReadResult, { kind: 'read' }>): GeminiRecord {
  const summary = buildSummaryRecord(item);
  const oldestFirst = [...read.exchanges].sort((a, b) => a.whenSec - b.whenSec);
  const started = read.whole && oldestFirst.length > 0 ? new DateString(oldestFirst[0].whenSec) : undefined;
  return {
    ...summary,
    is_summary: false,
    date: (started ?? summary.ended).timestamp(),
    turns: oldestFirst.map(turnOf),
    ...(started === undefined ? {} : { started }),
  };
}
