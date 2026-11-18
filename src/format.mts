// The data format: the number every record carries as format_version, and
// part of each upload key (keys.mts), so that after a change of format every
// chat in the crawl window is unsent and goes out once more. The extension
// that bundles this module serves it as data_format in the spider's config.
// Absent, or anything but a whole number from 1 to 999, it is 1, the format
// of every build before this number was read, so a build given no number
// sends what those builds sent. Pure.

export const FIRST_DATA_FORMAT = 1;
const LAST_DATA_FORMAT = 999;

export const isDataFormat = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= FIRST_DATA_FORMAT && (value as number) <= LAST_DATA_FORMAT;

export function dataFormatOf(value: unknown): number {
  return isDataFormat(value) ? value : FIRST_DATA_FORMAT;
}
