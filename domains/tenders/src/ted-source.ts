import {
  SourceError,
  type DiscoverySource, type FetchBatchRequest, type FetchBatchResult, type SourceItem,
} from '@discovery-platform/core';
import { createJsonClient } from './json-client.js';
import { parseCpvPrefixes, parsePrefixes, resolvePublicationRange } from './publication-range.js';

/**
 * TED (Tenders Electronic Daily, the EU's procurement journal) through its official Search API v3:
 * `POST https://api.ted.europa.eu/v3/notices/search`, anonymous, JSON. One request returns a page of notices with
 * exactly the fields asked for, so there is no per-notice detail request.
 *
 * Filters are part of the expert query (publication date, buyer country, CPV and NUTS prefixes as wildcards), so the
 * server does the filtering. The date range is bounded like every tender source (no historical import), the requests
 * are paced and retried politely (see json-client.ts), and the results are paged in the API's own default order
 * (ascending publication number), which is stable while paging.
 */
export const TED_SOURCE_ID = 'ted';
export const TED_SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';
const TED_ORIGIN = 'https://ted.europa.eu/';
const MAX_PAGE_SIZE = 250;
/** PAGE_NUMBER paging reaches at most this many results; a wider query must be narrowed instead. */
export const TED_MAX_RESULT_WINDOW = 15_000;

/** The notice fields the tender mapping reads. Asking for exactly these keeps the answer small. */
export const TED_FIELDS = [
  'publication-number', 'notice-identifier', 'notice-version', 'procedure-identifier', 'notice-type', 'publication-date', 'dispatch-date',
  'title-proc', 'title-lot', 'notice-title', 'description-proc', 'buyer-name', 'procedure-type', 'contract-nature',
  'classification-cpv', 'place-of-performance', 'deadline-receipt-tender-date-lot', 'deadline-receipt-tender-time-lot',
  'estimated-value-proc', 'estimated-value-cur-proc', 'estimated-value-lot', 'estimated-value-cur-lot', 'identifier-lot', 'links',
] as const;

/** One notice as the API returned it: only the requested fields, each optional. */
export type TedNoticeRaw = Record<string, unknown>;

export interface TedFilters {
  keywords: string;
  publishedFrom: string;
  publishedTo: string;
  /** ISO 3166-1 alpha-3 country of the buyer (the "land"); default NLD. */
  country: string;
  /** Keep notices with a CPV code starting with one of these (digits). Sent as wildcards in the query. */
  cpvPrefixes: string[];
  /** Keep notices with a place of performance starting with one of these NUTS prefixes (e.g. NL41). Sent as wildcards. */
  nutsPrefixes: string[];
}

export interface TedSourceStats { requests: number; retries: number; totalNotices: number | null }

export interface TedSourceOptions {
  searchUrl?: string;
  fetch?: typeof fetch;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface TedSource extends DiscoverySource<TedNoticeRaw> { stats(): TedSourceStats }

export function parseTedFilters(filters: Record<string, unknown> | undefined, today: Date = new Date()): TedFilters {
  const input = filters ?? {};
  const country = input.country === undefined || input.country === null || input.country === '' ? 'NLD' : input.country;
  const keywords = input.keywords ?? '';
  if (typeof keywords !== 'string' || keywords.length > 300 || /[\x00-\x1f]/.test(keywords)) throw new SourceError('keywords must be text of at most 300 characters.', 'invalid_filters');
  if (typeof country !== 'string' || !/^[A-Z]{3}$/.test(country)) throw new SourceError('country must be an ISO 3166-1 alpha-3 code (for example NLD).', 'invalid_filters');
  return {
    ...resolvePublicationRange(input, today), country, keywords: keywords.trim(),
    cpvPrefixes: parseCpvPrefixes(input.cpvPrefixes),
    nutsPrefixes: parsePrefixes(input.nutsPrefixes, 'nutsPrefixes', /^[A-Z]{2}[A-Z0-9]{0,3}$/),
  };
}

const compactDate = (iso: string) => iso.replace(/-/g, '');

/** The TED expert query for these filters (all values are validated above: digits, letters and fixed shapes only). */
export function buildTedQuery(filters: TedFilters): string {
  const clauses = [`buyer-country=${filters.country}`, `publication-date>=${compactDate(filters.publishedFrom)}`, `publication-date<=${compactDate(filters.publishedTo)}`];
  const anyOf = (field: string, prefixes: string[]) => (prefixes.length === 1 ? `${field}=${prefixes[0]}*` : `(${prefixes.map(prefix => `${field}=${prefix}*`).join(' OR ')})`);
  if (filters.cpvPrefixes.length > 0) clauses.push(anyOf('classification-cpv', filters.cpvPrefixes));
  if (filters.nutsPrefixes.length > 0) clauses.push(anyOf('place-of-performance', filters.nutsPrefixes));
  // Only literal words are interpolated, never user-supplied expert-query operators.
  const words = filters.keywords?.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 0) clauses.push(`(${words.map(word => `FT~"${word}"`).join(' OR ')})`);
  return clauses.join(' AND ');
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The public page of a notice: the API's own link (Dutch, then English, then any), else the canonical address. */
function noticeUrl(notice: Record<string, unknown>, publicationNumber: string): string {
  const links = record(notice.links);
  const html = record(links?.html) ?? record(links?.htmlDirect);
  const candidate = html && (html.NLD ?? html.ENG ?? Object.values(html)[0]);
  return typeof candidate === 'string' && candidate.startsWith(TED_ORIGIN) ? candidate : `${TED_ORIGIN}en/notice/-/detail/${publicationNumber}`;
}

export function createTedSource(options: TedSourceOptions = {}): TedSource {
  const searchUrl = options.searchUrl ?? TED_SEARCH_URL;
  const clock = options.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const client = createJsonClient({ serviceName: 'TED', fetch: options.fetch, clock, minIntervalMs: options.minIntervalMs, timeoutMs: options.timeoutMs ?? 30_000, maxRetries: options.maxRetries });
  let totalNotices: number | null = null;

  return {
    id: TED_SOURCE_ID,
    kind: 'api',
    stats: () => ({ ...client.stats(), totalNotices }),
    async fetchBatch(request: FetchBatchRequest): Promise<FetchBatchResult<TedNoticeRaw>> {
      const filters = parseTedFilters(request.filters, new Date(clock.now()));
      let page = 1;
      let limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.limit)));
      if (request.cursor !== null) {
        const match = /^(\d{1,4}):(\d{1,3})$/.exec(request.cursor);
        if (!match || Number(match[1]) < 1 || Number(match[2]) < 1 || Number(match[2]) > MAX_PAGE_SIZE) throw new SourceError('Invalid cursor.', 'invalid_filters');
        page = Number(match[1]);
        limit = Number(match[2]);
        if (limit > request.limit) throw new SourceError('The batch limit is smaller than the page size this cursor was created with.', 'invalid_filters');
      }
      const answer = record(await client.request(searchUrl, {
        method: 'POST', signal: request.signal,
        body: { query: buildTedQuery(filters), fields: TED_FIELDS, page, limit, paginationMode: 'PAGE_NUMBER', scope: 'ALL' },
      }));
      if (!answer || !Array.isArray(answer.notices) || typeof answer.totalNoticeCount !== 'number') throw new SourceError('TED returned an unexpected answer shape.', 'invalid_response');
      if (answer.timedOut === true) throw new SourceError('TED reported that the search timed out.', 'timeout', true);
      totalNotices = answer.totalNoticeCount;
      if (answer.totalNoticeCount > TED_MAX_RESULT_WINDOW) {
        throw new SourceError(`The query matches ${answer.totalNoticeCount} notices; narrow the dates or add a CPV/NUTS filter (at most ${TED_MAX_RESULT_WINDOW} can be paged).`, 'invalid_filters');
      }
      const items: SourceItem<TedNoticeRaw>[] = [];
      for (const entry of answer.notices) {
        const notice = record(entry);
        const publicationNumber = notice && typeof notice['publication-number'] === 'string' ? notice['publication-number'] : null;
        if (!notice || !publicationNumber || !/^\d{1,8}-\d{4}$/.test(publicationNumber)) continue;
        items.push({ externalId: publicationNumber, sourceUrl: noticeUrl(notice, publicationNumber), fetchedAt: new Date(clock.now()).toISOString(), raw: notice });
      }
      const exhausted = answer.notices.length === 0 || page * limit >= answer.totalNoticeCount;
      return { items, nextCursor: exhausted ? null : `${page + 1}:${limit}`, exhausted };
    },
  };
}
