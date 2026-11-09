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

// Answers the homepage and both list calls, and keeps every URL requested.
// Anything else, such as a list call without this page's token, gets a 404.
async function answerGemini(context, mainList: unknown[][], homeStatus = 200) {
  const requested: string[] = []
  await context.route('https://gemini.google.com/**', async (route) => {
    const request = route.request()
    requested.push(request.url())
    const url = new URL(request.url())
    if (url.pathname === '/app') {
      await route.fulfill({ status: homeStatus, contentType: 'text/html', body: '<script>WIZ_global_data = {"SNlM0e":"TEST-TOKEN:1"};</script>' })
      return
    }
    const form = new URLSearchParams(request.postData() ?? '')
    const listCall = url.pathname === '/_/BardChatUi/data/batchexecute' && url.searchParams.get('rpcids') === 'MaZiqc' && form.get('at') === 'TEST-TOKEN:1'
    if (!listCall) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const args = JSON.parse(JSON.parse(form.get('f.req') ?? '[]')[0][0][1])
    const main = JSON.stringify(args[2]) === '[0,null,1]'
    await route.fulfill({ status: 200, contentType: 'application/json', body: batch('MaZiqc', main ? [null, null, mainList] : []) })
  })
  return requested
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
// its defaults. sleep_delay 0 lets the next crawl start at once.
async function configure(serviceWorker) {
  await serviceWorker.evaluate(() => self.rexSpiderPlugin.updateConfiguration({ spiders: { gemini: { enabled: true, crawl_delay: 10, sleep_delay: 0 } } }))
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
  const requested = await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const first = await crawl(serviceWorker)
  expect(first.result).toEqual({ sitesCrawled: ['gemini'], issues: [] })
  expect(records(first.events)).toEqual([summary(2, T + 60, '2023-11-14T22:14:20Z'), summary(1, T, '2023-11-14T22:13:20Z')])
  expect(completions(first.events)).toEqual([[2, [chat(1), chat(2)], 'Fetch successful.']])

  const second = await crawl(serviceWorker)
  expect(records(second.events)).toEqual([])
  expect(completions(second.events)).toEqual([[0, [chat(1), chat(2)], 'Fetch successful.']])

  // rex-spider turns these patterns into rules that let the spider's own
  // requests through any blocking rules the extension sets. A request they
  // miss could be blocked.
  const allowed = await serviceWorker.evaluate(() => new Promise((resolve) => {
    self.rexCorePlugin.handleMessage({ messageType: 'fetchAllowedURLs' }, null, resolve)
  }))
  expect(requested.length).toBeGreaterThan(0)
  expect(requested.filter((url) => !allowed.some((pattern) => new RegExp(pattern).test(url)))).toEqual([])
})

test('a crawl whose homepage fails sends nothing and reports its reason and an issue', async ({ context, serviceWorker }) => {
  await answerGemini(context, [entry(1, T)], 500)
  await untilStoreOpen(serviceWorker)
  await configure(serviceWorker)

  const round = await crawl(serviceWorker)
  expect(records(round.events)).toEqual([])
  expect(completions(round.events)).toEqual([[-1, [], 'Homepage fetch failed (status 500).']])
  expect(round.result).toEqual({ sitesCrawled: ['gemini'], issues: [{ url: HOME, message: `Unable to fetch ${HOME}. Status code = 500.` }] })
})
