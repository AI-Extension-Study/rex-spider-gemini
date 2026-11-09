// The spider in a real MV3 service worker: rex-core, rex-spider and this
// module bundled as an extension would bundle them, gemini.google.com answered
// by routes, and each crawl started by the message the extension's alarm
// sends. Records are read back from a module registered with rex-core, as the
// data-upload module would receive them. Every id and title is made up.
import { test, expect } from './fixtures'

const T = 1700000000
const HOME = 'https://gemini.google.com/app'
const chat = (n: number) => `c_${n.toString(16).padStart(16, '0')}`
const entry = (n: number, seconds: number) => [chat(n), `Title ${n}`, null, null, null, [seconds, 457522000], null, null, null, 1]

function batch(rpcid: string, payload: unknown): string {
  const chunk = JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']])
  return `)]}'\n\n${chunk.length}\n${chunk}\n`
}

// The requests one crawl makes, as answerGemini writes them down.
const LIST_CALL = (variant: string) => `POST /_/BardChatUi/data/batchexecute MaZiqc ${variant} at=TEST-TOKEN:1`
const ONE_CRAWL = ['GET /app', LIST_CALL('[1,null,1]'), LIST_CALL('[0,null,1]')]

// Answers the homepage and both list calls, and keeps each request: its URL,
// and a line saying what it was. Anything but the homepage and a MaZiqc list
// call with this page's token gets a 404, and its line shows what was wrong.
// beforeMain, if given, is awaited before the main list is answered.
async function answerGemini(context, mainList: unknown[][], { homeStatus = 200, beforeMain = async () => {} } = {}) {
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
    let variant = 'unreadable-f.req'
    try {
      variant = JSON.stringify(JSON.parse(JSON.parse(form.get('f.req') ?? '')[0][0][1])[2])
    } catch {
      // Written down as unreadable, and refused below.
    }
    const call = `${request.method()} ${url.pathname} ${url.searchParams.get('rpcids')} ${variant} at=${form.get('at')}`
    calls.push(call)
    if (call !== LIST_CALL('[1,null,1]') && call !== LIST_CALL('[0,null,1]')) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const main = variant === '[0,null,1]'
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
// its defaults. rex-spider starts a crawl once more than sleep_delay ms have
// passed since the last one; -1 lets the next start at once, even within the
// same millisecond.
async function configure(serviceWorker) {
  await serviceWorker.evaluate(() => self.rexSpiderPlugin.updateConfiguration({ spiders: { gemini: { enabled: true, crawl_delay: 10, sleep_delay: -1 } } }))
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

// A summary record as the data-upload module receives it, every key.
const summary = (n: number, seconds: number, ended: string) => ({
  name: 'rex-conversation',
  is_summary: true,
  date: seconds * 1000,
  identifier: chat(n),
  turns: [],
  platform: 'gemini',
  ended,
  metadata: entry(n, seconds),
})

const completions = (events) => events
  .filter((event) => event.event_name === 'rex-spider-gemini-complete')
  .map((event) => [event.event_details.crawled_count, event.event_details.crawled_ids, event.event_details.reason])

test('a crawl sends a summary record per listed chat, newest first, and the next crawl sends none', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(traffic.calls.splice(0)).toEqual(ONE_CRAWL)
  expect(first.result).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(records(first.events)).toEqual([summary(2, T + 60, '2023-11-14T22:14:20Z'), summary(1, T, '2023-11-14T22:13:20Z')])
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

test('a crawl whose homepage fails sends nothing and reports its reason and an issue', async ({ context, serviceWorker }) => {
  const traffic = await answerGemini(context, [entry(1, T)], { homeStatus: 500 })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const round = await crawl(serviceWorker)
  expect(traffic.calls).toEqual(['GET /app'])
  expect(records(round.events)).toEqual([])
  expect(completions(round.events)).toEqual([[-1, [], 'Homepage fetch failed (status 500).']])
  expect(round.result).toEqual({ sitesCrawled: ['gemini'], issues: [{ url: HOME, message: `Unable to fetch ${HOME}. Status code = 500.` }] })
})

// The alarm starts a round every minute, and a pass can take longer. The
// crawling flag, set when a crawl starts, is what keeps two passes from
// running at once.
test('a round that starts while the spider is still crawling skips it', async ({ context, serviceWorker }) => {
  let reached: () => void = () => {}
  const mainListAsked = new Promise<void>((resolve) => { reached = resolve })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const traffic = await answerGemini(context, [entry(1, T)], { beforeMain: () => { reached(); return held } })
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)
  await serviceWorker.evaluate(() => { self.eventRecorder.events = [] })

  const round = () => serviceWorker.evaluate(() => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'beginBackgroundCrawls' }, null, resolve)
  }))
  const first = round()
  await mainListAsked
  const second = await round()
  release()
  expect(await first).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(second).toEqual({ sitesCrawled: [], issues: [] })
  expect(traffic.calls).toEqual(ONE_CRAWL)
  const events = await serviceWorker.evaluate(() => self.eventRecorder.events)
  expect(completions(events)).toEqual([[-1, [], '[gemini] Still crawling.'], [1, [chat(1)], 'Fetch successful.']])
})
