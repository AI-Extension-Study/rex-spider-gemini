import assert from 'node:assert/strict';
import { test } from 'node:test';

import { citationCount, countText, searchResultCount, withoutPlaceholderLinks } from '../../src/count.mts';
import { citationSlot, toolSlot } from './exchanges.mts';

test('countText counts Unicode code points, and words as runs of non-space characters holding a letter or digit', () => {
  assert.deepEqual(countText('Hello, world!'), { chars: 13, words: 2 });
  assert.deepEqual(countText('# Title\n- item | x'), { chars: 18, words: 3 }, 'Markdown marks are not words');
  assert.deepEqual(countText('👍'), { chars: 1, words: 0 }, 'a lone emoji is one character and no word');
  assert.deepEqual(countText('🇫🇷'), { chars: 2, words: 0 }, 'a flag is two code points');
  assert.deepEqual(countText('a\u00a0b\u3000c'), { chars: 5, words: 3 }, 'the no-break and ideographic spaces split words');
  assert.deepEqual(countText('日本語のテキスト'), { chars: 8, words: 1 });
  assert.deepEqual(countText('e\u0301'), { chars: 2, words: 1 }, 'a letter with a separate accent is two code points');
  assert.deepEqual(countText('\u00e9'), { chars: 1, words: 1 }, 'a letter with its accent built in is one');
  assert.deepEqual(countText(''), { chars: 0, words: 0 });
});

test('a placeholder link is removed, and only the link: the text right after it stays', () => {
  assert.equal(withoutPlaceholderLinks('A http://googleusercontent.com/map_content/0 B'), 'A  B');
  assert.equal(withoutPlaceholderLinks('[map](http://googleusercontent.com/map_content/1)'), '[map]()');
  assert.equal(withoutPlaceholderLinks('地図はhttp://googleusercontent.com/map_content/0です。続き'), '地図はです。続き');
  assert.equal(withoutPlaceholderLinks('See http://googleusercontent.com/map_content/0.'), 'See .');
  assert.equal(withoutPlaceholderLinks('A **http://googleusercontent.com/x/0** B'), 'A **** B');
  assert.equal(withoutPlaceholderLinks('HTTPS://GoogleUserContent.com/immersive_entry_chip/12'), '');
});

test('any other link is text and stays, an image on a googleusercontent.com subdomain included', () => {
  for (const kept of [
    'https://example.com/x', 'http://googleusercontent.com.example.org/y', 'http://notgoogleusercontent.com/map_content/0',
    'https://lh3.googleusercontent.com/abc=w100', 'https://lh3.googleusercontent.com/map_content/0', 'http://googleusercontent.com/no-number', 'no links',
    'https://example.com/?u=http://googleusercontent.com/map_content/0', 'https://example.com/http://googleusercontent.com/map_content/0',
    'https://example.com/?http://googleusercontent.com/map_content/0', 'https://example.com/?a=1&http://googleusercontent.com/map_content/0',
  ]) {
    assert.equal(withoutPlaceholderLinks(kept), kept);
  }
});

// A draft in the captured layout with the given citation slot at [2] and,
// when given, thoughts and tool calls at [37].
function draft(citations: unknown, tools?: unknown): unknown[] {
  const out: unknown[] = ['rc_0000000000000001', ['text'], citations];
  if (tools !== undefined) {
    while (out.length < 37) out.push(null);
    out.push(tools);
  }
  return out;
}

test('citationCount is the entries of the draft\'s [2][1]; a slot or entry list that is null, absent or empty holds none', () => {
  assert.equal(citationCount(draft(citationSlot(3))), 3);
  assert.equal(citationCount(draft(null)), 0);
  assert.equal(citationCount(['rc_0000000000000001', ['text']]), 0);
  assert.equal(citationCount(draft([])), 0);
  assert.equal(citationCount(draft([null, null])), 0, 'an entry list that is null, as a tool call list may be');
  assert.equal(citationCount(draft([null])), 0, 'no entry list');
});

test('citationCount is null when the slot or its list has another form, so a changed layout is not read as none', () => {
  for (const slot of ['not a list', 7, {}, [null, 'not a list'], [null, {}]]) {
    assert.equal(citationCount(draft(slot)), null, JSON.stringify(slot));
  }
  assert.equal(citationCount(null), null);
  assert.equal(citationCount('not a draft'), null);
});

test('searchResultCount sums the result lists of every tool call, and a call without one adds nothing', () => {
  assert.equal(searchResultCount(draft(null, toolSlot([9, null, 8]))), 17);
  assert.equal(searchResultCount(draft(null, toolSlot([]))), 0);
  assert.equal(searchResultCount(draft(null, toolSlot([null]))), 0);
  assert.equal(searchResultCount(draft(null)), 0, 'a draft with no [37]');
  assert.equal(searchResultCount(draft(null, null)), 0);
  assert.equal(searchResultCount(draft(null, [['thoughts only']])), 0);
});

test('searchResultCount is null when the slot, the calls or a result list has another form', () => {
  const resultsOdd = toolSlot([2]);
  ((resultsOdd[1] as unknown[])[0] as unknown[])[7] = 'not a list';
  const callOdd = toolSlot([2]);
  (callOdd[1] as unknown[]).push('not a call');
  for (const slot of ['not a list', [[''], 'not a list'], resultsOdd, callOdd]) {
    assert.equal(searchResultCount(draft(null, slot)), null, JSON.stringify(slot));
  }
  assert.equal(searchResultCount(null), null);
});
