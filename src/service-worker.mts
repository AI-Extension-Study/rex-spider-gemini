import { type Conversation, type DateString } from '@bric/rex-types/types'

import { type EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'

import rexSpiderPlugin, { REXSpider, type REXSpiderCrawlResult, type REXSpiderCrawlInspection } from '@bric/rex-spider/service-worker'

import { type Client, createClient } from './client.mts'
import { LIST_RPC, parseListPage, toConversation } from './list.mts'
import { sleep } from './pacing.mts'
import { bardErrorCodes, batchBody, batchUrl } from './wire.mts'

const GEMINI_SPIDER_PAGE_SIZE = 10

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

  fetchChats(): Promise<[REXSpiderCrawlInspection[], boolean]> {
    return new Promise<[REXSpiderCrawlInspection[], boolean]>((resolve, reject) => {
      const requestId = Math.floor(Math.random() * (999999 - 10000)) + 10000

      const chatsUrl = batchUrl(LIST_RPC, requestId)

      // The arguments of the list calls still to make, the last one first.
      const pending:unknown[][] = [
        [GEMINI_SPIDER_PAGE_SIZE, null, [0, null, 1]],
        [GEMINI_SPIDER_PAGE_SIZE, null, [1, null, 1]]
      ]

      const checkedRecords:REXSpiderCrawlInspection[] = []

      // Cleared by an answer the walk could not read in full, so the pass
      // reports itself as partial even when every call was made.
      let complete = true

      const fetchNext = () => {
        if (pending.length == 0) {
          resolve([checkedRecords, complete])
        } else {
          const args = pending.pop()

          if (args !== undefined) {
            this.client.postForm(chatsUrl, batchBody(LIST_RPC, args, this.accessToken as string)).then((answer) => {
              if (answer.kind !== 'ok') {
                reject(`Unable to crawl the conversation list (${answer.kind})`)
              } else if (answer.status < 200 || answer.status > 299) {
                if (checkedRecords.length === 0) {
                  reject(`List fetch failed (status ${answer.status}).`)
                } else {
                  console.log(`[rex-spider-gemini] Error parsing conversation list. Transmitting gathered conversations. Status code: ${answer.status}`)
                  resolve([checkedRecords, false])
                }
              } else {
                Promise.resolve(answer.text).then((rawBody) => {
                  if (bardErrorCodes(rawBody).includes(1096)) {
                    console.log(`[rex-spider-gemini] Error parsing conversation list. Authorization has likely expired. (This will be fixed soon.)`)
                    resolve([checkedRecords, false])

                    return
                  }

                  const page = parseListPage(rawBody)

                  if (page.kind === 'not-a-list') {
                    reject(`Received invalid response for conversation API. Request: ${JSON.stringify(args)}`)

                    return
                  }

                  // A failed list call is not an account without chats. The walk
                  // goes on to the calls left, and the pass reports itself as
                  // partial.
                  if (page.kind === 'error') {
                    console.log(`[rex-spider-gemini] A conversation list call answered with an error (code ${page.code}).`)

                    complete = false

                    pause(this.fetchCrawlDelay()).then(fetchNext)

                    return
                  }

                  if (page.skipped > 0) {
                    console.log(`[rex-spider-gemini] Skipped ${page.skipped} conversation list entries without an id or a time.`)

                    complete = false
                  }

                  if (page.next !== null) {
                    pending.push([args[0], page.next, args[2]])
                  }

                  const parsed:Conversation[] = page.items.map(toConversation)

                  const checkNextConversation = () => {
                    if (parsed.length === 0) {
                      pause(this.fetchCrawlDelay()).then(fetchNext)
                    } else {
                      const nextConvo:Conversation | undefined = parsed.pop()

                      if (nextConvo !== undefined && nextConvo.ended !== undefined) {
                        try {
                          this.crawlWindowContains(nextConvo.ended.timestamp()).then((include) => {
                            if (include && nextConvo.ended !== undefined) {
                              this.checkIfAlreadyTransmitted(nextConvo.identifier, nextConvo.ended).then((transmitted:boolean) => {
                                if (nextConvo.ended !== undefined) {
                                  if (transmitted) {
                                    checkedRecords.push({
                                      id: nextConvo.identifier,
                                      refresh: false,
                                      conversation: nextConvo,
                                      lookupDate: nextConvo.ended
                                    })
                                  } else {
                                    checkedRecords.push({
                                      id: nextConvo.identifier,
                                      refresh: true,
                                      conversation: nextConvo,
                                      lookupDate: nextConvo.ended
                                    })
                                  }
                                }

                                checkNextConversation()
                              })
                            } else {
                              checkNextConversation()
                            }
                          })
                        } catch (err) {
                          reject(`Error encountered processing conversation: ${err}`)
                        }
                      } else {
                        checkNextConversation()
                      }
                    }
                  }

                  checkNextConversation()
                })
                .catch((err) => {
                  reject(`Unable to process the conversation list: ${err}`)
                })
              }
            }).catch((err) => {
              reject(`Unable to crawl the conversation list: ${err}`)
            })
          } else {
            pause(this.fetchCrawlDelay()).then(fetchNext)
          }
        }
      }

      fetchNext()
    })
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
