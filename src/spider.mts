// The spider rex-spider runs for Gemini: its name, the URLs the extension
// lets it reach, the served mode, and a crawl that is one pass
// (src/pass.mts). src/service-worker.mts makes the instance and registers it.
import rexCorePlugin, { dispatchEvent } from '@bric/rex-core/service-worker';
import { REXSpider, type REXSpiderCrawlResult } from '@bric/rex-spider/service-worker';

import { type AccountSettings, accountSettings } from './account.mts';
import { createClient } from './client.mts';
import { dataFormatOf } from './format.mts';
import { HOME_URL, runPass } from './pass.mts';
import { sleep } from './pacing.mts';
import { createStore } from './store.mts';

// A key nothing stores. Reading it is the cheap extension call that keeps the
// worker awake through a wait or a slow call (src/pacing.mts).
const KEEP_ALIVE_KEY = 'rex-spider-gemini-keep-alive';

const keepAlive = () => chrome.storage.local.get(KEEP_ALIVE_KEY);

export class REXGeminiSpider extends REXSpider {
  client = createClient({ keepAlive });

  // rex-core's store, for the mode record. Called through an arrow, so
  // handleMessage keeps its this.
  store = createStore((message, sender, sendResponse) => rexCorePlugin.handleMessage(message, sender, sendResponse));

  // The served summarize setting as of the last config refresh: true is
  // summary mode, absent or false is detail. rex-spider keeps a flag of its
  // own that only ever turns on, so a config that turned summary off again
  // would not take.
  summarizes = false;

  // halt_on_error as served on the last config refresh: true, rex-spider's
  // default, ends a pass's detail reads at the first failed one. rex-spider's
  // own flag only ever turns off.
  haltsOnError = true;

  // The served account block as of the last config refresh: off unless it
  // says enabled true (account.mts).
  accountServed: AccountSettings = accountSettings(undefined);

  // The served data_format as of the last config refresh (format.mts): 1
  // unless it is a whole number from 1 to 999.
  dataFormatServed: number = dataFormatOf(undefined);

  // rex-spider calls this on each refresh whose config has a block for this
  // spider or a default one. With neither, the mode last served stays until
  // the worker restarts, as enabled does.
  updateConfiguration(configuration: Parameters<REXSpider['updateConfiguration']>[0]): void {
    super.updateConfiguration(configuration);
    this.summarizes = configuration.summarize === true;
    this.haltsOnError = configuration.halt_on_error !== false;
    // rex-spider's configuration type has no account key, so the served
    // block is read as unknown and checked in account.mts.
    this.accountServed = accountSettings('account' in configuration ? configuration.account : undefined);
    // Nor a data_format key: read as unknown and checked in format.mts.
    this.dataFormatServed = dataFormatOf('data_format' in configuration ? configuration.data_format : undefined);
  }

  account(): AccountSettings {
    return this.accountServed;
  }

  dataFormat(): number {
    return this.dataFormatServed;
  }

  justSummarize(): boolean {
    return this.summarizes;
  }

  continueAfterError(): boolean {
    return !this.haltsOnError;
  }

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
      store: this.store,
      now: () => Date.now(),
      // A shallow copy: rex-core's EventPayload has an index signature that
      // the records' interfaces do not.
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
