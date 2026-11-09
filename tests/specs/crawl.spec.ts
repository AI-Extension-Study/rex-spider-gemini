// The spider in a real MV3 service worker: rex-core, rex-spider and this
// module bundled as an extension would bundle them, gemini.google.com answered
// by routes, and the records read back from a module registered with rex-core,
// as the data-upload module would receive them. Every id and title is made up.
import { test, expect } from './fixtures'

const T = 1700000000
const chat = (n: number) => `c_${n.toString(16).padStart(16, '0')}`
const entry = (n: number, seconds: number) => [chat(n), `Title ${n}`, null, null, null, [seconds, 457522000], null, null, null, 1]

function batch(rpcid: string, payload: unknown): string {
  const chunk = JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']])
  return `)]}'\n\n${chunk.length}\n${chunk}\n`
}

async function answerGemini(context, mainList: unknown[][]) {
  await context.route('https://gemini.google.com/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/app') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<script>WIZ_global_data = {"SNlM0e":"TEST-TOKEN:1"};</script>' })
      return
    }
    const form = new URLSearchParams(request.postData() ?? '')
    const args = JSON.parse(JSON.parse(form.get('f.req') ?? '[]')[0][0][1])
    const main = JSON.stringify(args[2]) === '[0,null,1]'
    await route.fulfill({ status: 200, contentType: 'application/json', body: batch('MaZiqc', main ? [null, null, mainList] : []) })
  })
}

// rex-core answers store messages only once its database is open; a crawl
// started before then would end on its storage deadline.
async function untilStoreOpen(serviceWorker) {
  await expect.poll(() => serviceWorker.evaluate(() => new Promise((resolve) => {
    const handled = self.rexCorePlugin.handleMessage({ messageType: 'fetchValue', key: 'rex-spider-gemini-probe' }, null, () => resolve(true))
    if (!handled) resolve(false)
  })), { timeout: 15000 }).toBe(true)
}

async function crawl(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    self.eventRecorder.events = []
    await self.rexGeminiPlugin.doBackgroundCrawl()
    return self.eventRecorder.events
  })
}

test('a crawl sends a summary record per listed chat, newest first, and the next crawl sends none', async ({ context, serviceWorker }) => {
  await answerGemini(context, [entry(1, T), entry(2, T + 60)])
  await untilStoreOpen(serviceWorker)
  await serviceWorker.evaluate(() => self.rexGeminiPlugin.updateConfiguration({ enabled: true, crawl_delay: 10 }))

  const first = await crawl(serviceWorker)
  const records = first.filter((event) => event.name === 'rex-conversation')
  expect(records.map((record) => [record.identifier, record.is_summary, record.ended, record.platform])).toEqual([
    [chat(2), true, '2023-11-14T22:14:20Z', 'gemini'],
    [chat(1), true, '2023-11-14T22:13:20Z', 'gemini'],
  ])
  expect(records[0].metadata).toEqual(entry(2, T + 60))
  const done = first.filter((event) => event.event_name === 'rex-spider-gemini-complete')
  expect(done.map((event) => [event.event_details.crawled_count, event.event_details.reason])).toEqual([[2, 'Fetch successful.']])

  const second = await crawl(serviceWorker)
  expect(second.filter((event) => event.name === 'rex-conversation')).toEqual([])
  const again = second.filter((event) => event.event_name === 'rex-spider-gemini-complete')
  expect(again.map((event) => [event.event_details.crawled_count, event.event_details.reason])).toEqual([[0, 'Fetch successful.']])
})
