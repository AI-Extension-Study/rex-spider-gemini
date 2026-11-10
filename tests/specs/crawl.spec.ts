// The spider in a real MV3 service worker: rex-core, rex-spider and this
// module bundled as an extension would bundle them, gemini.google.com answered
// by routes, and each crawl started by the message the extension's alarm
// sends. Records are read back from a module registered with rex-core, as the
// data-upload module would receive them. Every id and title is made up.
import { test, expect } from './fixtures'

const T = 1700000000
const HOME = 'https://gemini.google.com/app'
const hex16 = (n: number) => n.toString(16).padStart(16, '0')
const chat = (n: number) => `c_${hex16(n)}`
const entry = (n: number, seconds: number) => [chat(n), `Title ${n}`, null, null, null, [seconds, 457522000], null, null, null, 1]
// A chat read: one exchange, a minute before the chat's last message, laid
// out as a real read (the prompt block holding the text alone, as some
// text-only prompts have, and the reply's drafts in [3][0]).
const read = (n: number, seconds: number) => [[[[chat(n), `r_${hex16(n)}`], null, [[`Prompt ${n}`]], [[[`rc_${hex16(n)}`, [`Reply ${n}`]]], null, null, `rc_${hex16(n)}`], [seconds - 60, 457522000]]], null, null, []]
// Whole seconds as a record's DateString serialises them.
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')

function batch(rpcid: string, payload: unknown): string {
  const chunk = JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']])
  return `)]}'\n\n${chunk.length}\n${chunk}\n`
}

// A failed call: no payload, the status in slot 5, as a read of a chat that
// is not there answers.
function batchError(rpcid: string, code: number): string {
  const chunk = JSON.stringify([['wrb.fr', rpcid, null, null, null, [code], 'generic']])
  return `)]}'\n\n${chunk.length}\n${chunk}\n`
}

// The requests one crawl makes, as answerGemini writes them down. A list
// call shows its whole argument list: page size, cursor and variant.
const LIST_CALL = (args: string) => `POST /_/BardChatUi/data/batchexecute MaZiqc ${args} at=TEST-TOKEN:1`
const OTHER_LIST = LIST_CALL('[10,null,[1,null,1]]')
const MAIN_LIST = LIST_CALL('[10,null,[0,null,1]]')
const ONE_CRAWL = ['GET /app', OTHER_LIST, MAIN_LIST]
const READ_CALL = (n: number) => `POST /_/BardChatUi/data/batchexecute hNvQHb ${JSON.stringify([chat(n), 200, null, 1, [0], [4], null, 1])} at=TEST-TOKEN:1`

// Answers the homepage, both list calls and a read of each listed chat, and
// keeps each request: its URL, and a line saying what it was. Anything else,
// such as a call without this page's token, gets a 404, and its line shows
// what was wrong. The main list is read at each call, so a test can add to
// it. beforeMain, if given, is awaited before the main list is answered; the
// reads of the chats in failReads answer with an error frame.
async function answerGemini(context, mainList: unknown[][], { homeStatus = 200, beforeMain = async () => {}, failReads = [] as number[] } = {}) {
  const urls: string[] = []
  const calls: string[] = []
  await context.route('https://gemini.google.com/**', async (route) => {
    const request = route.request()
    urls.push(request.url())
    const url = new URL(request.url())
    if (url.pathname === '/app') {
      calls.push(`${request.method()} /app`)
      await route.fulfill({ status: homeStatus, contentType: 'text/html', body: '<script>WIZ_global_data = {"SNlM0e":"TEST-TOKEN:1"};</script>' })
      return
    }
    const form = new URLSearchParams(request.postData() ?? '')
    let args = 'unreadable-f.req'
    try {
      args = JSON.stringify(JSON.parse(JSON.parse(form.get('f.req') ?? '')[0][0][1]))
    } catch {
      // Written down as unreadable, and refused below.
    }
    const call = `${request.method()} ${url.pathname} ${url.searchParams.get('rpcids')} ${args} at=${form.get('at')}`
    calls.push(call)
    const listed = mainList.find((listedEntry) => call === READ_CALL(Number.parseInt(String(listedEntry[0]).slice(2), 16)))
    if (listed !== undefined) {
      const n = Number.parseInt(String(listed[0]).slice(2), 16)
      const body = failReads.includes(n) ? batchError('hNvQHb', 5) : batch('hNvQHb', read(n, (listed[5] as number[])[0]))
      await route.fulfill({ status: 200, contentType: 'application/json', body })
      return
    }
    if (call !== OTHER_LIST && call !== MAIN_LIST) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const main = call === MAIN_LIST
    if (main) await beforeMain()
    await route.fulfill({ status: 200, contentType: 'application/json', body: batch('MaZiqc', main ? [null, null, mainList] : []) })
  })
  return { urls, calls }
}

// rex-core answers store messages only once its database is open; a crawl
// started before then would end on its storage deadline. While the database
// is still being created, a read can throw instead.
async function untilStoreOpen(serviceWorker) {
  await expect.poll(() => serviceWorker.evaluate(() => new Promise((resolve) => {
    try {
      const handled = self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key: 'rex-spider-gemini-probe' }, null, () => resolve(true))
      if (!handled) resolve(false)
    } catch {
      resolve(false)
    }
  })), { timeout: 15000 }).toBe(true)
}

// The served config as rex-spider applies it, the spider's block merged over
// its defaults, as on each refresh. rex-spider starts a crawl once more than
// sleep_delay ms have passed since the last one; -1 lets the next start at
// once, even within the same millisecond.
async function configure(serviceWorker, served = {}) {
  await serviceWorker.evaluate((gemini) => self.rexSpiderPlugin.updateConfiguration({ spiders: { gemini } }), { enabled: true, crawl_delay: 10, sleep_delay: -1, ...served })
}

// One round of the extension's alarm: each registered, enabled spider crawls,
// and the answer gathers their issues. The spider clears its crawling flag
// just after the round answers; until then a new round would skip it.
async function crawl(serviceWorker) {
  const round = await serviceWorker.evaluate(() => {
    self.eventRecorder.events = []
    return new Promise((resolve) => {
      self.rexCorePlugin.handleMessage({ messageType: 'beginBackgroundCrawls' }, null, (result) => resolve({ result, events: self.eventRecorder.events }))
    })
  })
  await expect.poll(() => serviceWorker.evaluate(() => self.rexGeminiPlugin.isCrawling())).toBe(false)
  return round
}

const records = (events) => events.filter((event) => event.name === 'rex-conversation')

// The upload keys a build that sent summaries only left behind, as rex-spider
// writes them: the bare chat id, the last-message time in ms, and the time
// of the stamp as the value.
async function seedSummaryKeys(serviceWorker, chats: [number, number][]) {
  await serviceWorker.evaluate((keys) => Promise.all(keys.map((key) => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'storeValue', key, value: Date.now() }, null, resolve)
  }))), chats.map(([n, seconds]) => `rex-spider-gemini-conversation-upload-${chat(n)}-${seconds * 1000}`))
}

// A summary record as the data-upload module receives it, every key.
const summary = (n: number, seconds: number, ended: string) => ({
  name: 'rex-conversation',
  is_summary: true,
  format_version: 1,
  date: seconds * 1000,
  identifier: chat(n),
  turns: [],
  platform: 'gemini',
  ended,
  metadata: entry(n, seconds),
})

// A detail record as the data-upload module receives it, every key: the
// exchange's two turns, with counts of the read's text and none of the text.
const detail = (n: number, seconds: number) => {
  const when = `${iso(seconds - 60).slice(0, -1)}.457522Z`
  return {
    name: 'rex-conversation',
    is_summary: false,
    format_version: 1,
    date: (seconds - 60) * 1000,
    identifier: chat(n),
    turns: [
      { identifier: `r_${hex16(n)}`, parent: null, speaker: 'user', when, on_current_branch: true,
        text_chars: `Prompt ${n}`.length, text_words: 2, citation_count: 0, search_result_count: 0, attachments: 0, attachment_types: [] },
      { identifier: `rc_${hex16(n)}`, parent: `r_${hex16(n)}`, speaker: 'assistant', when, on_current_branch: true,
        text_chars: `Reply ${n}`.length, text_words: 2, citation_count: 0, search_result_count: 0, attachments: 0, drafts: 1 },
    ],
    turns_complete: true,
    platform: 'gemini',
    ended: iso(seconds),
    started: iso(seconds - 60),
    metadata: entry(n, seconds),
  }
}

const completions = (events) => events
  .filter((event) => event.event_name === 'rex-spider-gemini-complete')
  .map((event) => [event.event_details.crawled_count, event.event_details.crawled_ids, event.event_details.reason])

test('served summarize, a crawl sends a summary record per listed chat, newest first, and the next crawl sends none', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })

  const first = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual(ONE_CRAWL)
  expect(first.result).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(records(first.events)).toEqual([summary(2, T + 60, '2023-11-14T22:14:20Z'), summary(1, T, '2023-11-14T22:13:20Z')])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], 'Fetch successful.']])

  const second = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual(ONE_CRAWL)
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2)], 'Fetch successful.']])
})

test('served no summarize, a crawl reads each listed chat and sends detail records, newest first, and the next crawl sends none', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual([...ONE_CRAWL, READ_CALL(2), READ_CALL(1)])
  expect(first.result).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(records(first.events)).toEqual([detail(2, T + 60), detail(1, T)])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], 'Fetch successful.']])

  const second = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual(ONE_CRAWL)
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2)], 'Fetch successful.']])

  // rex-spider serves these patterns, and the extension makes them rules that
  // let the spider's own requests through any blocking rules it sets. A
  // request they miss could be blocked.
  const allowed = await serviceWorker.evaluate(() => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'fetchAllowedURLs' }, null, resolve)
  }))
  expect(traffic.urls.filter((url) => !allowed.some((pattern) => new RegExp(pattern).test(url)))).toEqual([])
})

test('after an update, served summarize, the chats the old build sent are not sent again', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await seedSummaryKeys(serviceWorker, [[1, T], [2, T + 60]])
  await configure(serviceWorker, { summarize: true })

  const round = await crawl(serviceWorker)
  expect(traffic.calls).toEqual(ONE_CRAWL)
  expect(records(round.events)).toEqual([])
  expect(completions(round.events)).toEqual([[0, [chat(1), chat(2)], 'Fetch successful.']])
})

// The release serves no summarize, so its first pass is a switch to detail.
test('after an update, served no summarize, only the chats last used in the 90 days before it are re-sent, in detail', async ({ context, serviceWorker }) => {
  const now = Math.floor(Date.now() / 1000)
  const [old, recent] = [now - 100 * 86400, now - 3600]
  const traffic = await answerGemini(context, [entry(1, old), entry(2, recent)])
  await untilStoreOpen(serviceWorker)
  await seedSummaryKeys(serviceWorker, [[1, old], [2, recent]])
  await configure(serviceWorker)

  const round = await crawl(serviceWorker)
  expect(traffic.calls).toEqual([...ONE_CRAWL, READ_CALL(2)])
  expect(records(round.events)).toEqual([detail(2, recent)])
  expect(completions(round.events)).toEqual([[1, [chat(1), chat(2)], 'Fetch successful.']])
})

// A config may turn summary on later, and off again.
test('a switch of mode re-sends only the chats last used in the 90 days before it, and the switch back takes', async ({ context, serviceWorker }) => {
  // Three reads and a summary batch, with six waits of 3 s.
  test.setTimeout(60_000)
  const now = Math.floor(Date.now() / 1000)
  const [old, recent] = [now - 100 * 86400, now - 3600]
  const listed = [entry(1, old), entry(2, recent)]
  await answerGemini(context, listed)
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(records(first.events)).toEqual([detail(2, recent), detail(1, old)])

  await configure(serviceWorker, { summarize: true })
  const second = await crawl(serviceWorker)
  expect(records(second.events)).toEqual([summary(2, recent, iso(recent))])
  expect(completions(second.events)).toEqual([[1, [chat(1), chat(2)], 'Fetch successful.']])

  // Summary off again, and a new chat: it goes out in detail.
  listed.push(entry(3, now - 60))
  await configure(serviceWorker)
  const third = await crawl(serviceWorker)
  expect(records(third.events)).toEqual([detail(3, now - 60)])
})

test('a crawl whose homepage fails sends nothing and reports its reason and an issue', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T)], { homeStatus: 500 })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })

  const round = await crawl(serviceWorker)
  expect(traffic.calls).toEqual(['GET /app'])
  expect(records(round.events)).toEqual([])
  expect(completions(round.events)).toEqual([[-1, [], 'Homepage fetch failed (status 500).']])
  expect(round.result).toEqual({ sitesCrawled: ['gemini'], issues: [{ url: HOME, message: `Unable to fetch ${HOME}. Status code = 500.` }] })
})

// The alarm starts a round every minute, and a pass can take longer.
// rex-spider's crawling flag keeps two passes from running at once. It is set
// when the store write made at the start of a crawl is answered, not when the
// crawl is called, so a round within that write's round trip would still
// start a second pass (a gap in rex-spider). Here the first crawl is held at
// its main list call, well after that write.
test('a round that starts while the spider is still crawling skips it', async ({ context, serviceWorker }) => {
  let reached: () => void = () => {}
  const mainListAsked = new Promise<string>((resolve) => { reached = () => resolve('held at its main list call') })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  // Only the first main list call is held: a second pass, if one started,
  // runs through, and the test fails on its result rather than a timeout.
  let mainCalls = 0
  const traffic = await answerGemini(context, [entry(1, T)], {
    beforeMain: () => {
      mainCalls += 1
      if (mainCalls > 1) return Promise.resolve()
      reached()
      return held
    },
  })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { summarize: true })
  await serviceWorker.evaluate(() => { self.eventRecorder.events = [] })

  const round = () => serviceWorker.evaluate(() => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'beginBackgroundCrawls' }, null, resolve)
  }))
  const first = round()
  // A first round that ends before its main list call fails here, showing
  // its own result.
  expect(await Promise.race([mainListAsked, first])).toBe('held at its main list call')
  const second = await round()
  release()
  expect(second).toEqual({ sitesCrawled: [], issues: [] })
  expect(await first).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(traffic.calls).toEqual(ONE_CRAWL)
  const events = await serviceWorker.evaluate(() => self.eventRecorder.events)
  expect(completions(events)).toEqual([[-1, [], '[gemini] Still crawling.'], [1, [chat(1)], 'Fetch successful.']])
})

// The served configs say halt_on_error false; rex-spider's default is true,
// and its own flag, once false, never turns true again.
test('a failed read goes out as a summary and its memo holds the chat back, and a refresh without halt_on_error stops the reads at the next failure', async ({ context, serviceWorker }) => {
  test.setTimeout(60_000)
  const listed = [entry(1, T), entry(2, T + 60)]
  const traffic = await answerGemini(context, listed, { failReads: [2, 3] })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker, { halt_on_error: false })

  const first = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual([...ONE_CRAWL, READ_CALL(2), READ_CALL(1)])
  expect(records(first.events)).toEqual([summary(2, T + 60, iso(T + 60)), detail(1, T)])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], 'Fetch successful.']])

  const second = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual(ONE_CRAWL)
  expect(records(second.events)).toEqual([])

  // A new chat whose read fails, and an older one after it.
  listed.push(entry(3, T + 120), entry(4, T + 30))
  await configure(serviceWorker)
  const third = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual([...ONE_CRAWL, READ_CALL(3)])
  expect(records(third.events)).toEqual([summary(3, T + 120, iso(T + 120))])
  expect(completions(third.events)).toEqual([[1, [chat(1), chat(2), chat(3), chat(4)], 'Crawl stopped: detail reads failed.']])
  expect(third.result.issues).toEqual([{ url: HOME, message: 'Crawl stopped: detail reads failed.' }])
})
