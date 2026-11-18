# rex-spider-gemini

The Gemini crawler for a research browser extension (this fork of bric-digital's `rex-spider-gemini`). While a participant's browser is open and signed in to gemini.google.com, it reads their Gemini chat list with their own sign-in and uploads one record for each new or changed chat. A summary record is the chat's entry in that list. A detail record adds two turns per exchange, the prompt's and the reply's, with counts made in the browser: characters, words, citations, search results and attached files. Message text never leaves the browser. Records follow the conversation record layout the ChatGPT fork also uses, and carry the data format the served configuration gives, 1 unless it says otherwise (see "The data format").

**Where it stands, 2026-11-13.** The extension installs this fork at `a7e780e` from its release v0.0.59 (2026-11-13) on, and carries a copy of that commit's `src/redact.mts` as its Gemini case. Releases before v0.0.59 install bric-digital's `6198c4b`, which ignores `summarize` and sends only list records. A browser served no `summarize` for Gemini runs this fork in detail mode. After such a release, its first pass fixes the time the 90 days count back from, and the chats last changed in those 90 days are sent again, once, as detail records, over as many passes as the 360 s reading budget takes.

## What it collects

| | summary mode | detail mode |
|---|---|---|
| per chat | id (`c_` and hex), the last message's time, and the chat's list entry | the same, plus `started`, the first exchange's time, when the read returned the whole chat |
| per exchange | nothing | two turns, the prompt's and the shown reply's, with counts (below) |

With the served `account` setting on (off by default), it also sends an account record: whether Gemini Apps Activity is on (see "The account record").

Never collected: message text (only counts), the reply's other drafts (only how many there were), thinking, tool results, file names or contents (only their types), links, and which model answered.

## How a pass works

The extension starts a crawl round every minute, but only while an ID is stored and only when its configuration request gets an HTTP answer. rex-spider starts a Gemini pass when none is running and `sleep_delay` has passed since the last one.

1. Read `https://gemini.google.com/app` for the page token (`SNlM0e`) the site's own requests carry. A page without one ends the pass.
2. If the account read is on and due, make its one call (see "The account record").
3. Walk the chat list: the `MaZiqc` call to `/_/BardChatUi/data/batchexecute`, 10 chats a page, in two list calls (`[1,null,1]`, then `[0,null,1]`), each followed to its last page on every pass, `crawl_delay` between pages. A chat both calls list counts once. The walk does not stop at the crawl window, since neither list's order is confirmed.
4. Keep the chats whose last message falls in the crawl window and that have no upload key in the served mode (see "Modes and the re-send"). They go out newest first.
5. Summary mode sends the list entries as records, 25 at a time. Detail mode reads each chat with the `hNvQHb` call, which returns its newest 200 exchanges, `crawl_delay` apart and never closer than 3 s.
6. Send one completion event (see "Reading the completion events").

The page token is read again from `/app` before the next list call or detail read once it is 25 minutes old (a walk of about 50 pages at the 30 s pace), and the detail reads go on with the one the walk last read. How long Google keeps a token has not been measured; on one account passes failed at about 33 minutes of pass time, so 25 leaves a margin. The next request waits `crawl_delay` after the re-read (in detail mode, never less than 3 s).

Detail reads stop once a pass has spent 360 s reading (requests, parsing and storage calls; the waits do not count), counted from its first read. Chats not reached keep no key and go out in a later pass. Waits run in steps of at most 20 s with a cheap extension call before each, every request gives up after 20 s, and a list is cut after 1,000 pages or 3 pages in a row that bring no new chat.

## What a record holds

Top level: `name` (`rex-conversation`), `platform` (`gemini`), `identifier` (the chat id), `format_version` (the data format), `is_summary`, `date`, `ended`, `turns`, `metadata`. A detail record adds `turns_complete`, and `started` when known. `ended` is the last message's time from the list, in whole seconds. `date` is `ended` in epoch ms for a summary record, and `started` (else `ended`) for a detail record. `metadata` is the list entry, an array: `[0]` the chat id, `[1]` the title's SHA-256 hash, `[5]` the last message as `[seconds, nanoseconds]`.

| key | prompt turn | reply turn |
|---|---|---|
| `identifier` | the exchange's response id (`r_…`) | the shown draft's id (`rc_…`) |
| `parent` | the draft the prompt followed (`rc_…`); null on the first exchange | the exchange's response id |
| `speaker` | `user` | `assistant` |
| `when` | the exchange's time, in UTC to the nanosecond | the same time |
| `on_current_branch` | always `true` | always `true` |
| `text_chars`, `text_words` | the prompt's text | the shown draft's text, less placeholder links |
| `citation_count` | 0 | cited passages in the shown draft, one per passage |
| `search_result_count` | 0 | results of every tool call in the shown draft, whatever the tool |
| `attachments` | files attached to the prompt | 0 |
| extra | `attachment_types`: each file's MIME type if it is `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/heic`, `image/heif`, `application/pdf`, `text/plain` or `text/csv`, else `other` | `drafts`: how many drafts the reply had |

`text_chars` counts Unicode code points, and `text_words` runs of non-space characters holding a letter or a digit. Placeholder links (`http(s)://googleusercontent.com/<kind>/<number>`) mark where the page draws a widget such as a map or a place card, and are removed before the reply is counted. A count is null when what it is made from has another form, and with no draft of the shown id all four reply counts are null. An empty or absent citation or result list counts 0, since that is how Gemini says none, so if Google moved those lists the counts would read 0, not null. `turns_complete` is false when the read was cut or skipped an exchange it could not read, and such a record has no `started`.

## Modes and the re-send

`summarize: true` is summary mode; absent or `false` is detail mode. The spider takes the setting again, in both directions, at every configuration refresh whose configuration has a `gemini` or `default` block, and checks it before each detail read: summary mode served during the reads ends them, and the next pass runs in summary mode.

Each mode has its own upload key: the bare chat id in summary mode, the key earlier builds wrote, and `<chat id>-detail` in detail mode, each with the last message's time. Under a data format above 1, both ids end in `-f<format>` (see "The data format"). The spider stores the served mode and when this browser's first pass in it ran (`rex-spider-gemini-mode`). A chat with a key only in the other mode is sent again, once, if its last message is no earlier than 90 days before that pass; older chats keep the record they have. A browser with no stored mode counts as switching on its first pass.

## The data format

`data_format` in the served configuration is a whole number from 1 to 999; absent, or anything else, it is 1. The extension that bundles this module sets it, and a build given no number sends exactly what earlier builds sent. Every record carries it as `format_version`, the account record included, and it is part of each upload key:

| format | summary mode | detail mode |
|---|---|---|
| 1 | `<chat id>` | `<chat id>-detail` |
| n > 1 | `<chat id>-f<n>` | `<chat id>-detail-f<n>` |

A pass reads the format once, when it starts, and looks up only that format's keys. So after a change of format every chat in the crawl window has no key in either mode, and goes out once more in the served mode, however long ago it was last used and whether or not the mode changed too; in detail mode that is a read of every chat, over as many passes as the 360 s reading budget takes. Within one format, a switch of mode re-sends the last 90 days, as above. A failed detail read's summary is checked against the summary key of the pass's format, and the hold of 1 or 7 days it starts is kept per format too (`rex-spider-gemini-detail-memo-<chat id>`, with `-f<n>` above format 1), so a hold from the old format does not keep a chat from being read under the new one. The account record's hash covers `format_version`, so the first account read under a new format sends it; that read comes once `interval_minutes` have passed since the last one, so up to that long after the first pass under the new format (60 minutes by default).

The old format's upload keys and holds stay in the extension's store after a change of format. Nothing reads, writes or clears them again, so they hold nothing back; they are one small value per chat sent, and per chat whose read failed.

## The account record

Off unless the served configuration turns it on (see "Settings it reads"). When on, a pass reads Gemini Apps Activity once the interval has passed since the last read, or when the stored read time is more than 5 minutes ahead of the clock (the clock moved back). The read is one `ESY5D` call to `/_/BardChatUi/data/batchexecute` with `[null,[5]]`, after the page token and before the list, with `crawl_delay` before it and again before the first list call (never less than 3 s). It answers `[[null,null,null,null,true]]` with activity on and `false` with it off.

The record is a `rex-account` point of its own, in the account record layout the AI crawlers share: `name` (`rex-account`), `platform` (`gemini`), `format_version` (the data format), `date` (the read, epoch ms), then `plan`, `paid`, `workspace`, `web_search_enabled`, `training_allowed`, `history_saved`, `memory_enabled`, `custom_instructions_set`, `account_created`, `source_status` and `metadata`. Gemini fills only `history_saved` (activity on or off; with it off Gemini keeps no chats); the other standard keys are null, `source_status` is `{"ESY5D": <HTTP status>}` and `metadata` is `{}`.

A record goes out when the call answered HTTP 200 with the flag, and it differs from the last one sent, or that one went out 24 hours ago or more (or more than 5 minutes ahead of the clock). Any other status, a rate limit, a failed call, an expired session or any other answer sends nothing. Once the call is made, whatever it answered, the read time is stored under `rex-spider-gemini-account` (with the last record's hash and send time), so the next read comes an interval later. No call is made, and nothing is stored, when the stored state gets no answer, or when the spider or the account read is switched off during the wait before the call. The account read never changes a pass's reason, count or issues.

## What is removed, and how

1. The read parser keeps ids, times, counts, the prompt's attachment MIME types and the reply's draft count. The prompt and the shown reply are read only to be counted, in the browser; nothing else of a reply is read.
2. The extension runs the redactor, `src/redact.mts`, on every `rex-conversation` record with `platform` `gemini` before upload, passing the data format it accepts (`redactGemini(event, hashTitle, format)`); the redactor holds no format number of its own. A record the spider built, of that format, comes back with the title at `metadata[1]` replaced by its SHA-256 hash, each turn's keys in their forms, and any other key dropped. The title reaches the redactor as text, and the hash has no secret key, so someone who guesses a title exactly can confirm the guess. Every other position of the list entry is kept only when it is null, true or false, a number, an id of a short prefix and hex (`c_…`, `rc_…`), or a list of those up to three levels deep; anything else becomes null. Any other such record, one of another format included, keeps only `date`, `name`, `platform`, `identifier` and the uploader's own keys (`generatorId`, `_pdk_trace_context`, `passive-data-metadata`). The redactor never rejects, because rex-content-processing uploads a rejected processor's input unredacted. Completion events are not filtered.

## When something fails

- A list call that fails once a chat in the window was listed (an HTTP error, no answer within 20 s, a network error, an answer that is not a list, an expired session), or a page token that cannot be read again during the walk, ends the walk: the chats listed go out and the pass reports partial. A failed call before then, the first list call included, ends the pass with its error and -1. In detail mode, after a list call with no answer, not a list or an HTTP error, the reads first read the page token again; if that fails, no chat is read and none gets a memo, so all wait for a later pass.
- A failed detail read sends the chat's summary record in the detail's place, once per last-message time, unless one already went out at that time. The chat then waits 1 day before the next try after a first failure that may pass by itself (no answer, a 5xx, a 429) and 7 days otherwise; a chat with a newer last message is read at once.
- Failed reads also end the pass's reads, as `halt_on_error` sets (see "Settings it reads"). A 429 or a 503 ends them at once, so under a lasting rate limit each pass tries one chat and each chat still gets its summary. An expired session (error code 1096 in Gemini's answer) ends them with no wait for the chat.

## Reading the completion events

Each pass sends one event, `rex-spider-gemini-complete`, with `crawled_count`, `crawled_ids` and `reason`. The reasons are fixed sentences, and a count of -1 comes with no ids, so a failed pass never looks like deleted chats:

| reason | `crawled_count`, `crawled_ids` |
|---|---|
| `Fetch successful.` | records sent; every chat in the window |
| `Full fetch unsuccessful. Partial results returned.` | records sent; the chats in the window that were listed, not the whole list |
| `Crawl stopped: detail reads failed.`, `Crawl stopped: the server asked to wait.` | records sent; every chat in the window (the list was read whole) |
| `Crawl stopped: spider disabled.` | -1 if switched off before the list was read, else records sent and the chats listed |
| `No access token found on homepage.` | -1: not signed in |
| `Homepage fetch failed (status N).`, `Error encountered fetching network resource: timeout.` (or `network.`) | -1 |
| `Error encountered parsing conversations: ...` | -1: a list call failed or the session expired before any chat in the window was listed, the list was read only in part and gave no chat in the window, or the pass hit an unexpected error (`internal error (<kind>)`) |
| `Crawl stopped: the extension storage did not answer.` | -1 |
| `[gemini] Still crawling.` | -1; sent by rex-spider each minute a pass is still running, not a pass |

## Settings it reads

rex-spider merges `spider.spiders.gemini` over `spider.spiders.default` from the served configuration.

| key | default | effect |
|---|---|---|
| `enabled` | `true` | `false` stops a pass before its next request |
| `summarize` | absent | `true` for summary mode, else detail mode |
| `halt_on_error` | `true` | `true` ends the detail reads at the first failed read, `false` at three in a row |
| `crawl_delay` | `30000` | ms between requests; a value that does not read as a positive number means no wait between list pages and 3 s between reads |
| `sleep_delay` | `300000` | ms between passes, applied by rex-spider |
| `data_format` | absent | a whole number from 1 to 999 is the data format; anything else, or absent, is 1 (see "The data format") |
| `account` | absent | `{"enabled": true}` turns on the account read (see "The account record"); `interval_minutes`, a whole number from 15 to 1440, sets minutes between reads, else 60. A `gemini` block's `account` replaces the `default` one whole |
| `start`, `end`, `time_anchor` | none, none, `runtime` | the crawl window: `start` and `end` in ms from the install time (`install`) or from now (`runtime`), or as epoch ms (`absolute`); a chat is in it by its last message |

## What it cannot see

- Anything while the browser is closed or signed out of Google.
- Edits and earlier branches: a read returns one thread, so `on_current_branch` is always `true`. The reply's other drafts are counted in `drafts`; only the shown draft is a turn.
- Separate times for a prompt and its reply: Gemini gives one time per exchange, and both turns carry it.
- A deletion as an event: a deleted chat stops appearing in the `crawled_ids` of `Fetch successful.` events.

## Running the tests

Node 24.11 or later. `npm ci`, then `npm run lint` and `npm run test:unit` (Node's test runner, no browser). `npm run test:specs` runs `tests/specs/crawl.spec.ts` in Chromium with Playwright: whole passes in a real service worker, with gemini.google.com answered by routes and every id and title made up. `npm test` runs both suites. CI runs the build, lint and both suites on every pull request and on `main` (`.github/workflows/ci.yml`).

## How a change reaches the extension

The extension installs this module from a pinned commit and carries a copy of `src/redact.mts` from that commit as its Gemini case. A change here reaches participants only after the extension pins the new commit, its copy is made again from that commit, and a release ships both.

## Where to read next

`src/record.mts` builds the records from what `src/read.mts` and `src/count.mts` take from a chat, `src/redact.mts` is the redactor, `src/pass.mts` and `src/walk.mts` run a pass, and `src/reasons.mts` holds the reasons.

## What is in this repo

`src/` holds the crawler: the entry point the extension imports (`service-worker.mts`), the spider (`spider.mts`) and one module per job; `browser.mts` and `extension.mts` are empty. `tests/unit/` holds the Node unit tests, and `tests/specs/`, `tests/src/` and `tests/extension/` the Playwright spec and the test extension it loads. CI is `.github/workflows/ci.yml`; `.circleci/` is bric-digital's.

## Keeping this current

A pull request that changes what a record holds, what is removed, the calls made, the pace, the reasons or the settings updates this README in the same pull request.
