import {
  SourceError,
  type DiscoverySource, type FetchBatchRequest, type FetchBatchResult, type SourceItem,
} from '@discovery-platform/core';

/**
 * TenderNed (the Dutch national tender platform) as an API source, on its PUBLIC JSON endpoints: a paged
 * publication list plus one detail document per publication. These endpoints need no credentials and the
 * data is published as CC0, but the JSON shape is not part of TenderNed's documented contract (only the
 * credentialed XML endpoint is), so everything read from it is treated as optional and validated.
 *
 * Deliberately small: a bounded publication-date range (never a historical import), a fixed pause between
 * requests, one request at a time, a timeout per request and a few retries for transient failures only.
 */
export const TENDERNED_SOURCE_ID = 'tenderned';
export const TENDERNED_BASE_URL = 'https://www.tenderned.nl/papi/tenderned-rs-tns/v2';
const TENDERNED_ORIGIN = 'https://www.tenderned.nl/';
const PUBLICATION_PAGE_URL = 'https://www.tenderned.nl/aankondigingen/overzicht/';

export const MAX_RANGE_DAYS = 14;
export const DEFAULT_RANGE_DAYS = 2;
const MAX_PAGE_SIZE = 100;
const MAX_BODY_CHARS = 5_000_000;

/** What one batch item carries: the list entry and (when fetched and available) the detail document. */
export interface TenderNedRaw {
  list: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  /** Why the detail is missing although it was wanted (a failed request), otherwise null. */
  detailError: string | null;
}

export interface TenderNedFilters {
  /** First publication date to include (YYYY-MM-DD). */
  publishedFrom: string;
  /** Last publication date to include (YYYY-MM-DD). */
  publishedTo: string;
  /** Keep only publications with a CPV code starting with one of these (digits). Decided client-side from the detail. */
  cpvPrefixes: string[];
  /** Keep only publications with a NUTS code starting with one of these (e.g. "NL33"). Decided client-side from the detail. */
  nutsPrefixes: string[];
}

export interface TenderNedSourceStats {
  requests: number;
  retries: number;
  detailFailures: number;
  /** Publications dropped by the client-side CPV/NUTS filter. */
  filteredOut: number;
}

export interface TenderNedSourceOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  /** Minimum pause between two requests. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Fetch the detail document per publication (needed for CPV/NUTS). Default true. */
  fetchDetails?: boolean;
}

export interface TenderNedSource extends DiscoverySource<TenderNedRaw> {
  stats(): TenderNedSourceStats;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
function parseDate(value: unknown, name: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) throw new SourceError(`${name} must be a date (YYYY-MM-DD).`, 'invalid_filters');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) throw new SourceError(`${name} is not a valid date.`, 'invalid_filters');
  return date;
}
function prefixes(value: unknown, name: string, pattern: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !pattern.test(item))) {
    throw new SourceError(`${name} must be a list of valid code prefixes.`, 'invalid_filters');
  }
  return [...new Set(value as string[])];
}

/**
 * Validates run filters. The date range is bounded on purpose: no dates means the last two days, and a range
 * longer than 14 days is refused rather than silently shortened, so a run is never an accidental bulk import.
 */
export function parseTenderNedFilters(filters: Record<string, unknown> | undefined, today: Date = new Date()): TenderNedFilters {
  const input = filters ?? {};
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
  return {
    publishedFrom: isoDate(start), publishedTo: isoDate(end),
    cpvPrefixes: prefixes(input.cpvPrefixes, 'cpvPrefixes', /^\d{2,8}$/),
    nutsPrefixes: prefixes(input.nutsPrefixes, 'nutsPrefixes', /^[A-Z]{2}[A-Z0-9]{0,3}$/),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createTenderNedSource(options: TenderNedSourceOptions = {}): TenderNedSource {
  const baseUrl = (options.baseUrl ?? TENDERNED_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const clock = options.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const minIntervalMs = options.minIntervalMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const fetchDetails = options.fetchDetails ?? true;
  const stats: TenderNedSourceStats = { requests: 0, retries: 0, detailFailures: 0, filteredOut: 0 };
  let lastRequestAt = -Infinity;

  async function getJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
    let lastError: SourceError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new SourceError('The request was aborted.', 'aborted');
      const wait = lastRequestAt + minIntervalMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastRequestAt = clock.now();
      stats.requests++;
      if (attempt > 0) stats.retries++;
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        response = await doFetch(url, {
          headers: { accept: 'application/json', 'user-agent': 'DiscoveryCoreBot/1.0' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw new SourceError('The request was aborted.', 'aborted');
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastError = new SourceError(timedOut ? `TenderNed did not answer within ${timeoutMs} ms.` : 'TenderNed could not be reached.', timedOut ? 'timeout' : 'http', true);
        await backoff(attempt, null);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new SourceError(`TenderNed answered HTTP ${response.status}.`, 'http', true, response.status);
        await backoff(attempt, response.headers.get('retry-after'));
        continue;
      }
      if (!response.ok) throw new SourceError(`TenderNed answered HTTP ${response.status}.`, 'http', false, response.status);
      const body = await response.text();
      if (body.length > MAX_BODY_CHARS) throw new SourceError('TenderNed returned an unexpectedly large response.', 'invalid_response');
      try { return JSON.parse(body); } catch { throw new SourceError('TenderNed did not return valid JSON.', 'invalid_response'); }
    }
    throw lastError ?? new SourceError('TenderNed could not be reached.', 'http', true);
  }
  async function backoff(attempt: number, retryAfter: string | null) {
    if (attempt >= maxRetries) return;
    const seconds = retryAfter && /^\d{1,3}$/.test(retryAfter) ? Math.min(30, Number(retryAfter)) : attempt + 1;
    await clock.sleep(seconds * 1000);
  }

  const matches = (codes: unknown, wanted: string[]) =>
    Array.isArray(codes) && codes.some(entry => {
      const code = typeof record(entry)?.code === 'string' ? String(record(entry)!.code) : '';
      return wanted.some(prefix => code.startsWith(prefix));
    });

  return {
    id: TENDERNED_SOURCE_ID,
    kind: 'api',
    stats: () => ({ ...stats }),
    async fetchBatch(request: FetchBatchRequest): Promise<FetchBatchResult<TenderNedRaw>> {
      const filters = parseTenderNedFilters(request.filters, new Date(clock.now()));
      let page = 0;
      let size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.limit)));
      if (request.cursor !== null) {
        const match = /^(\d{1,5}):(\d{1,3})$/.exec(request.cursor);
        if (!match || Number(match[2]) < 1 || Number(match[2]) > MAX_PAGE_SIZE) throw new SourceError('Invalid cursor.', 'invalid_filters');
        page = Number(match[1]);
        size = Number(match[2]);
        if (size > request.limit) throw new SourceError('The batch limit is smaller than the page size this cursor was created with.', 'invalid_filters');
      }
      const listUrl = `${baseUrl}/publicaties?page=${page}&size=${size}&publicatieDatumVanaf=${filters.publishedFrom}&publicatieDatumTot=${filters.publishedTo}`;
      const list = record(await getJson(listUrl, request.signal));
      if (!list || !Array.isArray(list.content)) throw new SourceError('TenderNed returned an unexpected list shape.', 'invalid_response');
      const wantsDetail = fetchDetails || filters.cpvPrefixes.length > 0 || filters.nutsPrefixes.length > 0;
      const items: SourceItem<TenderNedRaw>[] = [];
      for (const entry of list.content) {
        const publication = record(entry);
        const id = publication && (typeof publication.publicatieId === 'string' || typeof publication.publicatieId === 'number') ? String(publication.publicatieId) : null;
        if (!publication || !id || !/^\d{1,12}$/.test(id)) continue;
        let detail: Record<string, unknown> | null = null;
        let detailError: string | null = null;
        if (wantsDetail) {
          try { detail = record(await getJson(`${baseUrl}/publicaties/${id}`, request.signal)); }
          catch (error) {
            if (error instanceof SourceError && error.code === 'aborted') throw error;
            stats.detailFailures++;
            detailError = error instanceof SourceError ? `${error.code}: ${error.message}` : 'unknown';
          }
        }
        if (filters.cpvPrefixes.length > 0 && !matches(detail?.cpvCodes, filters.cpvPrefixes)) { stats.filteredOut++; continue; }
        if (filters.nutsPrefixes.length > 0 && !matches(detail?.nutsCodes, filters.nutsPrefixes)) { stats.filteredOut++; continue; }
        const link = record(publication.link)?.href;
        items.push({
          externalId: id,
          sourceUrl: typeof link === 'string' && link.startsWith(TENDERNED_ORIGIN) ? link : `${PUBLICATION_PAGE_URL}${id}`,
          fetchedAt: new Date(clock.now()).toISOString(),
          raw: { list: publication, detail, detailError },
        });
      }
      const totalPages = typeof list.totalPages === 'number' ? list.totalPages : null;
      const exhausted = list.last === true || list.content.length === 0 || (totalPages !== null && page + 1 >= totalPages);
      return { items, nextCursor: exhausted ? null : `${page + 1}:${size}`, exhausted };
    },
  };
}
