import { type Conversation, type DateString } from '@bric/rex-types/types'

import { type EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'

import rexSpiderPlugin, { REXSpider, type REXSpiderCrawlResult, type REXSpiderCrawlInspection } from '@bric/rex-spider/service-worker'

import { type Client, createClient } from './client.mts'
import { toConversation } from './list.mts'
import { sleep } from './pacing.mts'
import { walkList } from './walk.mts'

// A key nothing stores. Reading it is the cheap extension call that keeps the
// worker awake through a wait (src/pacing.mts).
const KEEP_ALIVE_KEY = 'rex-spider-gemini-keep-alive'

const keepAlive = () => chrome.storage.local.get(KEEP_ALIVE_KEY)

function pause(ms:number): Promise<void> {
  return sleep(ms, { keepAlive })
}

export class REXGeminiSpider extends REXSpider {
  accessToken:string|null = null

  client:Client = createClient({ keepAlive })

  fetchUrls(): string[] {
    return []
  }

  name(): string {
    return 'Gemini'
  }

  identifier(): string {
    return 'gemini'
  }

  loginUrl(): string {
    return 'https://gemini.google.com/app'
  }

  allowedUrls():string[] {
    return [
      '^https://gemini.google.com/app$',
      '^https://gemini.google.com/_/BardChatUi/data/batchexecute\\?.*',
    ]
  }

  fetchInitialUrls(): string[] {
    return []
  }

  checkLogin(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      fetch(this.loginUrl()).then((response: Response) => {
        if (response.ok) {
          response.text().then((rawHtml) => {
            if (rawHtml.includes("<span class=\"gb_ie\">Sign in</span>")) {
                resolve(false)
            } else {
              resolve(true)
            }
          })
          .catch((err) => {
            console.log(`[rex-spider-gemini] Error fetching login page text (${this.loginUrl()}): ${err}`)

            resolve(false)
          })
        } else {
          resolve(false)
        }
      }).catch((err) => {
        console.log(`[rex-spider-gemini] Error fetching login page (${this.loginUrl()}): ${err}`)

        resolve(false)
      })
    })
  }

  async fetchChats(): Promise<[REXSpiderCrawlInspection[], boolean]> {
    const walk = await walkList({
      client: this.client,
      sleep: pause,
      crawlDelay: () => this.fetchCrawlDelay(),
      at: this.accessToken as string,
      requestId: Math.floor(Math.random() * (999999 - 10000)) + 10000
    })

    // Each listed chat in the crawl window, and whether it went out before at
    // this last-message time.
    const inspected:REXSpiderCrawlInspection[] = []

    for (const item of walk.items) {
      const conversation = toConversation(item)
      const ended = conversation.ended as DateString

      if (await this.crawlWindowContains(ended.timestamp())) {
        const transmitted = await this.checkIfAlreadyTransmitted(item.id, ended)

        inspected.push({ id: item.id, refresh: !transmitted, conversation, lookupDate: ended })
      }
    }

    const stop = walk.stop

    if (stop === null) {
      return [inspected, walk.complete]
    }

    switch (stop.kind) {
      case 'expired':
        console.log(`[rex-spider-gemini] Error parsing conversation list. Authorization has likely expired. (This will be fixed soon.)`)

        return [inspected, false]
      case 'http':
        if (inspected.length === 0) {
          throw `List fetch failed (status ${stop.status})`
        }

        console.log(`[rex-spider-gemini] Error parsing conversation list. Transmitting gathered conversations. Status code: ${stop.status}`)

        return [inspected, false]
      case 'not-a-list':
        throw 'Received invalid response for conversation API'
      default:
        throw `Unable to crawl the conversation list (${stop.kind})`
    }
  }

  doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
    return new Promise<REXSpiderCrawlResult>((resolve) => {
      super.doBackgroundCrawl().then((crawlResult:REXSpiderCrawlResult) => {
        const homeUrl = 'https://gemini.google.com/app'

        this.client.get(homeUrl).then((answer) => {
          const crawledIds:string[] = []

          if (answer.kind !== 'ok') {
            this.signalCrawlComplete(-1, [], `Error encountered fetching network resource: ${answer.kind}.`)

            crawlResult.issues.push({
              url: this.loginUrl(),
              message: `Error encountered fetching network resource: ${answer.kind}.`
            })

            resolve(crawlResult)
          } else if (answer.status < 200 || answer.status > 299) {
            this.signalCrawlComplete(-1, [], `Homepage fetch failed (status ${answer.status}).`)

            crawlResult.issues.push({
              url: this.loginUrl(),
              message: `Unable to fetch ${homeUrl}. Status code = ${answer.status}.`
            })

            resolve(crawlResult)
          } else {
            Promise.resolve(answer.text).then((rawHtml) => {
              if (rawHtml.includes('"SNlM0e":"')) {
                const startIndex = rawHtml.indexOf('"SNlM0e":"')

                if (startIndex !== -1) {
                  const prefixStripped = rawHtml.substring(startIndex)

                  const tokens = prefixStripped.split('"')

                  if (tokens.length > 3) {
                    this.accessToken = tokens[3]
                  }
                }

                if (this.accessToken === null) {
                  this.signalCrawlComplete(-1, [], `No access token found on homepage.`)

                  crawlResult.issues.push({
                    url: this.loginUrl(),
                    message: `No access token found on homepage.`
                  })

                  resolve(crawlResult)
                } else {
                  this.fetchChats().then(([inspectionRecords, complete]) => {
                    let dispatched = 0

                    const processNextConversation = () => {
                      if (inspectionRecords.length <= 0) {
                        if (complete) {
                          this.signalCrawlComplete(dispatched, crawledIds, 'Fetch successful.')
                        } else {
                          this.signalCrawlComplete(dispatched, crawledIds, 'Full fetch unsuccessful. Partial results returned.')
                        }

                        resolve(crawlResult)
                      } else {
                        const inspectionRecord:REXSpiderCrawlInspection | undefined = inspectionRecords.pop()

                        if (inspectionRecord !== undefined && inspectionRecord.conversation !== undefined) {
                          crawledIds.push(inspectionRecord.id)

                          const conversation:Conversation = inspectionRecord.conversation

                          if (conversation.ended !== undefined) {
                            const ended:DateString = conversation.ended

                            if (inspectionRecord.refresh) {
                              this.checkIfAlreadyTransmitted(inspectionRecord.id, inspectionRecord.lookupDate).then((transmitted:boolean) => {
                                if (transmitted === false && ended.value !== null) {
                                  const payload: EventPayload = {
                                    name: 'rex-conversation',
                                    date: ended.value.epochMilliseconds,
                                    ...conversation
                                  }

                                  try {
                                    dispatchEvent(payload)

                                    dispatched += 1

                                    this.logTransmitted(inspectionRecord.id, inspectionRecord.lookupDate).then(() => {
                                      processNextConversation()
                                    })
                                  } catch (err) {
                                    console.log(`[rex-spider-gemini] Error transmitting data point: ${err}`)

                                    processNextConversation()
                                  }
                                } else {
                                  processNextConversation()
                                }
                              })
                            } else {
                              processNextConversation()
                            }
                          } else {
                            processNextConversation()
                          }
                        } else {
                          processNextConversation()
                        }
                      }
                    }

                    processNextConversation()
                  }).catch((err) => {
                    this.signalCrawlComplete(-1, crawledIds, `Error encountered parsing conversations: ${err}.`)

                    crawlResult.issues.push({
                      url: this.loginUrl(),
                      message: `Error encountered parsing conversations: ${err}.`
                    })

                    resolve(crawlResult)
                  })
                }
              } else {
                this.signalCrawlComplete(-1, crawledIds, `No access token found on homepage.`)

                crawlResult.issues.push({
                  url: this.loginUrl(),
                  message: `No access token found on homepage.`
                })

                resolve(crawlResult)
              }
            })
            .catch((err) => {
              this.signalCrawlComplete(-1, crawledIds, `Error encountered fetching conversations: ${err}.`)

              crawlResult.issues.push({
                url: this.loginUrl(),
                message: `Error fetching conversations: ${err}.`
              })

              resolve(crawlResult)
            })
          }
        }).catch((err) => {
          this.signalCrawlComplete(-1, [], `Error encountered fetching network resource: ${err}.`)

          crawlResult.issues.push({
            url: this.loginUrl(),
            message: `Error encountered fetching network resource: ${err}.`
          })

          resolve(crawlResult)
        })
      })
    })
  }
}

const geminiSpider = new REXGeminiSpider()

rexSpiderPlugin.registerSpider(geminiSpider)

export default geminiSpider
