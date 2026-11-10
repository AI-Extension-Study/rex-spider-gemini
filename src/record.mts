// The rex-conversation records the spider sends, in the standard record
// layout the AI crawlers share (format 1): each turn is the REX Turn with its
// content-free keys kept and its text-bearing keys replaced by counts made in
// the browser. Pure.
//
// A summary record is the record this spider has always sent, built from the
// list entry alone, with is_summary true and the format version. A detail
// record has every field of the summary record, so code that reads one reads
// the other, and adds the chat's start, whether its turns are complete, and
// two turns per exchange, the prompt's and then the reply's. The metadata of
// both is the raw list entry: its title is hashed by the extension that
// bundles this module.
import { DateString } from '@bric/rex-types/types';

import { type ListItem, toConversation } from './list.mts';
import { type Exchange, type ReadResult } from './read.mts';

export const FORMAT_VERSION = 1;

// A turn's standard keys, in their order. A count is null when what it is
// made from had another form.
interface StandardTurn {
  readonly identifier: string | null;
  // The turn this one follows; it can name one the record does not hold.
  readonly parent: string | null;
  readonly speaker: 'user' | 'assistant';
  // The exchange's time as an ISO instant, to the nanosecond the read gives.
  // Gemini gives one time per exchange, so both its turns carry it.
  readonly when: string;
  // A read returns one thread, and a draft that is not shown is not a turn.
  readonly on_current_branch: true;
  readonly text_chars: number | null;
  readonly text_words: number | null;
  readonly citation_count: number | null;
  readonly search_result_count: number | null;
  readonly attachments: number | null;
}

export interface GeminiUserTurn extends StandardTurn {
  readonly speaker: 'user';
  // Null, as attachments is, when the prompt's file list has another form.
  readonly attachment_types: readonly string[] | null;
}

export interface GeminiAssistantTurn extends StandardTurn {
  readonly speaker: 'assistant';
  readonly drafts: number | null;
}

export type GeminiTurn = GeminiUserTurn | GeminiAssistantTurn;

export interface GeminiRecord {
  readonly name: 'rex-conversation';
  readonly is_summary: boolean;
  readonly format_version: typeof FORMAT_VERSION;
  // Epoch ms: the last message for a summary record, the start for a detail
  // record whose start is known, as the other REX spiders' records do.
  readonly date: number;
  readonly identifier: string;
  readonly turns: readonly GeminiTurn[];
  // A detail record's: whether turns hold every message of the chat.
  readonly turns_complete?: boolean;
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
    format_version: FORMAT_VERSION,
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

// An exchange's two turns: the prompt, which follows the draft Gemini says it
// followed, and the shown reply, which follows the prompt.
function turnsOf(exchange: Exchange): [GeminiUserTurn, GeminiAssistantTurn] {
  const when = instant(exchange).toJSON();
  return [
    {
      identifier: exchange.responseId,
      parent: exchange.parentDraftId,
      speaker: 'user',
      when,
      on_current_branch: true,
      text_chars: exchange.prompt?.chars ?? null,
      text_words: exchange.prompt?.words ?? null,
      // A prompt carries no citations or search results.
      citation_count: 0,
      search_result_count: 0,
      attachments: exchange.attachmentTypes === null ? null : exchange.attachmentTypes.length,
      attachment_types: exchange.attachmentTypes === null ? null : [...exchange.attachmentTypes],
    },
    {
      identifier: exchange.shownDraftId,
      parent: exchange.responseId,
      speaker: 'assistant',
      when,
      on_current_branch: true,
      text_chars: exchange.reply.text?.chars ?? null,
      text_words: exchange.reply.text?.words ?? null,
      citation_count: exchange.reply.citations,
      search_result_count: exchange.reply.searchResults,
      // A reply carries no attached files.
      attachments: 0,
      drafts: exchange.drafts,
    },
  ];
}

// started is set only when the read came back whole, since otherwise the
// oldest exchange may be missing. It is whole seconds, as ended is (the
// upload key is built from ended); the nanoseconds stay in each turn's when.
// The list is read before the chats are, so a chat that gains messages in
// between has turns after ended; the next pass sends it again under its new
// ended. The read sends exchanges newest first: reversed before the stable
// sort, two exchanges with one time keep their order, a reply after the
// prompt it answers.
export function buildDetailRecord(item: ListItem, read: Extract<ReadResult, { kind: 'read' }>): GeminiRecord {
  const summary = buildSummaryRecord(item);
  const oldestFirst = [...read.exchanges].reverse().sort((a, b) => a.whenSec - b.whenSec || a.whenNanos - b.whenNanos);
  // A start after the listed end means the chat's oldest exchange changed
  // between the list call and the read (its first prompt edited, say): the
  // list's time is stale, and a start after it would make the record
  // inconsistent, so it is left out, as for a read that was cut.
  const oldest = oldestFirst.length > 0 ? oldestFirst[0] : undefined;
  const started = read.whole && oldest !== undefined && oldest.whenSec <= item.endedSec ? new DateString(oldest.whenSec) : undefined;
  return {
    ...summary,
    is_summary: false,
    date: (started ?? summary.ended).timestamp(),
    turns: oldestFirst.flatMap(turnsOf),
    turns_complete: read.whole,
    ...(started === undefined ? {} : { started }),
  };
}
