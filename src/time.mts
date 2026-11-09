// Gemini sends times as epoch seconds, in its list and its read alike. A
// value outside these bounds (2001 to 2286) is not seconds: a time in
// milliseconds would otherwise read as a date some 50,000 years ahead, and a
// far larger one throws in DateString.
const EARLIEST_SECONDS = 1e9;
const LATEST_SECONDS = 1e10;

export function isPlausibleSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= EARLIEST_SECONDS && value < LATEST_SECONDS;
}
