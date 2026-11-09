// The reasons a pass reports in the spider's completion event. The first
// four sentences are the ones this spider has always sent, word for word,
// since tools match them (a pass that read the whole list says exactly
// "Fetch successful."). An error reason says where the pass stopped and
// never carries an error's own text, which could hold a URL or a token.
export const FETCH_SUCCESSFUL = 'Fetch successful.';
export const PARTIAL = 'Full fetch unsuccessful. Partial results returned.';
export const NO_TOKEN = 'No access token found on homepage.';
export const homepageFailed = (status: number) => `Homepage fetch failed (status ${status}).`;
export const homepageUnreachable = (kind: 'timeout' | 'network') => `Error encountered fetching network resource: ${kind}.`;
export const listFailed = (what: string) => `Error encountered parsing conversations: ${what}.`;
export const STORE_SILENT = 'Crawl stopped: the extension storage did not answer.';
export const DISABLED = 'Crawl stopped: spider disabled.';
// Detail reads failed: one with halt_on_error, or several in a row without.
export const DETAIL_FAILED = 'Crawl stopped: detail reads failed.';
// A list read only in part that gave no chat in the crawl window. It reports
// no reading (count -1): an empty one would look like an emptied account.
// It is worded as a list error, not as a partial fetch, since a partial
// fetch's reason comes with a count and ids that are a reading.
export const NO_RESULTS = listFailed('List read only in part, with no conversation in the crawl window');
