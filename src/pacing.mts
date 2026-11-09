// Every wait of a crawl goes through sleep. A wait is cut into chunks of at
// most CHUNK_MS with a keep-alive call before each, so the service worker is
// never idle long enough for Chrome to stop it in the middle of a crawl.
// Measured in Chrome: an MV3 worker died during a bare 60 s timer, and a bare
// 30 s one sat at the edge; crawl_delay is 30 s unless the config sets another.
export const CHUNK_MS = 20_000;

export interface SleepOptions {
  // A cheap extension API call. Making it resets the worker's idle timer.
  readonly keepAlive: () => unknown;
  readonly wait?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nameOf = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export async function sleep(ms: number, { keepAlive, wait = timer, log = (line) => console.log(`[rex-spider-gemini] ${line}`) }: SleepOptions): Promise<void> {
  const failed = (error: unknown) => {
    try {
      log(`keep-alive failed (${nameOf(error)})`);
    } catch {
      // A log that throws has nowhere left to report to.
    }
  };
  for (let left = ms; left > 0; left -= CHUNK_MS) {
    // Not awaited: the call resets the idle timer when it is made, and one
    // that never answers must not hold the wait.
    try {
      Promise.resolve(keepAlive()).catch(failed);
    } catch (error) {
      failed(error);
    }
    await wait(Math.min(left, CHUNK_MS));
  }
}
