// Requests to gemini.google.com with the browser's cookies. Each one ends
// within timeoutMs, reading the body included, and resolves to one of three
// answers rather than rejecting, so a caller sorts every outcome in one place
// and a request that never answers cannot hold a crawl, or the spider's
// crawling flag, until the worker restarts.
export type Answer =
  | { readonly kind: 'ok'; readonly status: number; readonly text: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' };

export interface Client {
  get(url: string): Promise<Answer>;
  postForm(url: string, body: URLSearchParams): Promise<Answer>;
}

export const REQUEST_TIMEOUT_MS = 20_000;

export interface ClientOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export function createClient({ fetch: send = (url, init) => fetch(url, init), timeoutMs = REQUEST_TIMEOUT_MS }: ClientOptions = {}): Client {
  async function request(url: string, init: RequestInit): Promise<Answer> {
    const controller = new AbortController();
    // Raced against the request and the body read, so the timeout holds even
    // where an abort does not reach them.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
    });
    aborted.catch(() => {});
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await Promise.race([send(url, { ...init, credentials: 'include', signal: controller.signal }), aborted]);
      const text = await Promise.race([response.text(), aborted]);
      return { kind: 'ok', status: response.status, text };
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    get: (url) => request(url, { method: 'GET' }),
    postForm: (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }),
  };
}
