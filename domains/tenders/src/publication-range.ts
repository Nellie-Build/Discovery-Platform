import { SourceError } from '@discovery-platform/core';

/**
 * The bounded publication-date range every tender source uses: never a bulk import. No dates means the last two
 * days, a lone start date gets a two-day window (never beyond today), and a range longer than the maximum is
 * refused rather than silently shortened. Plain-string dates only (YYYY-MM-DD).
 */
export const MAX_RANGE_DAYS = 90;
export const DATE_BLOCK_DAYS = 7;
export const DEFAULT_RANGE_DAYS = 2;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

function parseDate(value: unknown, name: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) throw new SourceError(`${name} must be a date (YYYY-MM-DD).`, 'invalid_filters');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) throw new SourceError(`${name} is not a valid date.`, 'invalid_filters');
  return date;
}

export function resolvePublicationRange(input: Record<string, unknown>, today: Date): { publishedFrom: string; publishedTo: string } {
  const day = 86_400_000;
  const todayUtc = new Date(`${isoDate(today)}T00:00:00Z`);
  const from = parseDate(input.publishedFrom, 'publishedFrom');
  const to = parseDate(input.publishedTo, 'publishedTo');
  const end = to ?? (from ? new Date(Math.min(todayUtc.getTime(), from.getTime() + (DEFAULT_RANGE_DAYS - 1) * day)) : todayUtc);
  const start = from ?? new Date(end.getTime() - (DEFAULT_RANGE_DAYS - 1) * day);
  if (start.getTime() > end.getTime()) throw new SourceError('publishedFrom is after publishedTo.', 'invalid_filters');
  if ((end.getTime() - start.getTime()) / day + 1 > MAX_RANGE_DAYS) {
    throw new SourceError(`The publication date range may span at most ${MAX_RANGE_DAYS} days.`, 'invalid_filters');
  }
  return { publishedFrom: isoDate(start), publishedTo: isoDate(end) };
}

/** Inclusive, non-overlapping windows, newest first. Keeps national-source requests small. */
export function publicationBlocks(range: { publishedFrom: string; publishedTo: string }) {
  const blocks: Array<{ publishedFrom: string; publishedTo: string }> = [];
  const first = Date.parse(range.publishedFrom);
  for (let end = Date.parse(range.publishedTo); end >= first;) {
    const start = Math.max(first, end - (DATE_BLOCK_DAYS - 1) * 86_400_000);
    blocks.push({ publishedFrom: isoDate(new Date(start)), publishedTo: isoDate(new Date(end)) });
    end = start - 86_400_000;
  }
  return blocks;
}

/** A list of code prefixes (at most 50, each matching `pattern`), or an empty list when absent. */
export function parsePrefixes(value: unknown, name: string, pattern: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !pattern.test(item))) {
    throw new SourceError(`${name} must be a list of valid code prefixes.`, 'invalid_filters');
  }
  return [...new Set(value as string[])];
}

/**
 * CPV prefixes as categories: a full code's trailing zeros are hierarchy padding, so 92111000 means "92111…" and also
 * covers its subcategory 92111200, as TenderNed's own filter does. Never shorter than the two-digit division.
 */
export function parseCpvPrefixes(value: unknown): string[] {
  return [...new Set(parsePrefixes(value, 'cpvPrefixes', /^\d{2,8}$/).map(prefix => prefix.replace(/0+$/, '').padEnd(2, '0')))];
}
