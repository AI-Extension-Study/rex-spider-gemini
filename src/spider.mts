// The spider rex-spider runs for Gemini: its name, the URLs the extension
// lets it reach, and a crawl that is one pass (src/pass.mts).
// src/service-worker.mts makes the instance and registers it.
import { dispatchEvent } from '@bric/rex-core/service-worker';
import { REXSpider, type REXSpiderCrawlResult } from '@bric/rex-spider/service-worker';

import { createClient } from './client.mts';
import { HOME_URL, runPass } from './pass.mts';
import { sleep } from './pacing.mts';

// A key nothing stores. Reading it is the cheap extension call that keeps the
// worker awake through a wait or a slow call (src/pacing.mts).
const KEEP_ALIVE_KEY = 'rex-spider-gemini-keep-alive';

const keepAlive = () => chrome.storage.local.get(KEEP_ALIVE_KEY);

export class REXGeminiSpider extends REXSpider {
  client = createClient({ keepAlive });

  fetchUrls(): string[] {
    return [];
  }

  name(): string {
    return 'Gemini';
  }

  identifier(): string {
    return 'gemini';
  }

  loginUrl(): string {
    return HOME_URL;
  }

  allowedUrls(): string[] {
    return [
      '^https://gemini.google.com/app$',
      '^https://gemini.google.com/_/BardChatUi/data/batchexecute\\?.*',
    ];
  }

  fetchInitialUrls(): string[] {
    return [];
  }

  // Moved unchanged from the old entry file. Nothing calls it.
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

  // The base stamps the crawl's start and sets its crawling flag. The pass
  // never throws, and its outcome is the crawl's one completion event, which
  // clears the flag again.
  async doBackgroundCrawl(): Promise<REXSpiderCrawlResult> {
    const result = await super.doBackgroundCrawl();
    const outcome = await runPass({
      client: this.client,
      framework: this,
      // A shallow copy: rex-core's EventPayload has an index signature that
      // the record's interface does not.
      dispatch: (record) => dispatchEvent({ ...record }),
      sleep: (ms) => sleep(ms, { keepAlive }),
      keepAlive,
      requestId: Math.floor(Math.random() * (999999 - 10000)) + 10000,
    });
    if (outcome.issue !== null) {
      result.issues.push({ url: this.loginUrl(), message: outcome.issue });
    }
    this.signalCrawlComplete(outcome.crawledCount, outcome.crawledIds, outcome.reason);
    return result;
  }
}
