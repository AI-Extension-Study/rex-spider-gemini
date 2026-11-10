// Counts made from a chat's text in the participant's browser, so that a
// record says how much was written and never what. The read parser calls
// these; no text leaves them. Pure.

export interface TextCounts {
  readonly chars: number;
  readonly words: number;
}

// JavaScript's whitespace, which holds the no-break and the ideographic space.
const SPACE = /\s/u;
// A letter or a digit of any script.
const WORDLIKE = /[\p{L}\p{N}]/u;

// A text's length in Unicode code points, so a CJK character or most emoji
// count one, while an emoji built of several, such as a flag, or a letter
// written with a separate accent counts more; code points, unlike what a
// reader sees as one character, do not change with the browser's Unicode
// version. And its words: runs of non-space characters holding a letter or a
// digit, so Markdown marks such as #, - and | and a lone emoji are none. What
// counts as a letter, a digit or a space can change a little with that
// version. Text written without spaces between words, as Chinese and
// Japanese are, counts few words; compare across languages by characters.
export function countText(text: string): TextCounts {
  let chars = 0;
  let words = 0;
  // Whether the current run of non-space characters was counted as a word.
  let counted = false;
  for (const character of text) {
    chars += 1;
    if (SPACE.test(character)) {
      counted = false;
    } else if (!counted && WORDLIKE.test(character)) {
      words += 1;
      counted = true;
    }
  }
  return { chars, words };
}

// A placeholder link, http(s)://googleusercontent.com/<kind>/<number>, marks
// where the page draws a widget (a map, a place card, a document chip), not
// text anyone reads, so it is removed before the reply is counted. Only that
// form is removed, and only the link: text written right after it, as
// Chinese and Japanese are, stays. Any other link is text the reader sees,
// an image on a googleusercontent.com subdomain included, and so is a
// placeholder's form inside another link, right after a URL mark such as
// / = ? or &. A placeholder on a line of its own leaves that line's breaks, a
// few characters.
const PLACEHOLDER = /(?<![/=?&])https?:\/\/googleusercontent\.com\/[A-Za-z0-9_-]+\/\d+/giu;

export function withoutPlaceholderLinks(text: string): string {
  return text.replace(PLACEHOLDER, '');
}

const isAbsent = (value: unknown): boolean => value === null || value === undefined;

// A draft's citations sit at [2] as [_, entries], one entry per cited passage
// of the reply, each holding the passage's start and end in the reply and its
// sources. A slot or entry list that is null, absent or empty holds none, as
// the tool calls' lists do; one of another form gives null, so a changed
// layout reads as unknown, not none.
export function citationCount(draft: unknown): number | null {
  if (!Array.isArray(draft)) {
    return null;
  }
  const slot: unknown = draft[2];
  if (isAbsent(slot)) {
    return 0;
  }
  if (!Array.isArray(slot)) {
    return null;
  }
  const entries: unknown = slot[1];
  if (isAbsent(entries)) {
    return 0;
  }
  return Array.isArray(entries) ? entries.length : null;
}

// A draft's thoughts and tool calls sit at [37] as [[thoughts], calls]. A web
// search call lists its results at [7]; a call with no results, such as a map
// lookup, has no [7]. The count is every result of every call, whatever the
// tool, since a call names its tool only in display text. A slot, a call list
// or a result list that is null or absent holds none; one of another form
// gives null.
export function searchResultCount(draft: unknown): number | null {
  if (!Array.isArray(draft)) {
    return null;
  }
  const slot: unknown = draft[37];
  if (isAbsent(slot)) {
    return 0;
  }
  if (!Array.isArray(slot)) {
    return null;
  }
  const calls: unknown = slot[1];
  if (isAbsent(calls)) {
    return 0;
  }
  if (!Array.isArray(calls)) {
    return null;
  }
  let total = 0;
  for (const call of calls) {
    if (!Array.isArray(call)) {
      return null;
    }
    const results: unknown = call[7];
    if (isAbsent(results)) {
      continue;
    }
    if (!Array.isArray(results)) {
      return null;
    }
    total += results.length;
  }
  return total;
}
