import { createJsonClient } from './json-client.js';
import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, parseCpvPrefixes, parsePrefixes, resolvePublicationRange, publicationBlocks } from './publication-range.js';
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

export { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS };

/**
 * The list endpoint filters on CPV server-side and hierarchically (92000000 covers every 92xxxxxx code); repeated
 * parameters are OR-ed. It needs the "12345678-9" format but matches on the eight digits only (verified 2026-09-24),
 * so the check digit is sent as 0. Should TenderNed start validating it, the request fails loudly (the run marks
 * the source failed) instead of silently returning less; the client-side check below stays as the safety net.
 */
export const cpvQuery = (prefixes: string[]) => prefixes.map(prefix => `&cpvCodes=${prefix.padEnd(8, '0')}-0`).join('');
const MAX_PAGE_SIZE = 100;

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
  /** Keep only publications with a CPV code starting with one of these (digits). Sent to the list endpoint (`cpvCodes`,
   * hierarchical) and checked again client-side from the detail. */
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
  publicationsScanned: number;
  dateBlocks: number;
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

/**
 * Validates run filters. The date range is bounded on purpose: no dates means the last two days, and a range
 * longer than 14 days is refused rather than silently shortened, so a run is never an accidental bulk import.
 */
export function parseTenderNedFilters(filters: Record<string, unknown> | undefined, today: Date = new Date()): TenderNedFilters {
  const input = filters ?? {};
  return {
    ...resolvePublicationRange(input, today),
    cpvPrefixes: parseCpvPrefixes(input.cpvPrefixes),
    nutsPrefixes: parsePrefixes(input.nutsPrefixes, 'nutsPrefixes', /^[A-Z]{2}[A-Z0-9]{0,3}$/),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createTenderNedSource(options: TenderNedSourceOptions = {}): TenderNedSource {
  const baseUrl = (options.baseUrl ?? TENDERNED_BASE_URL).replace(/\/+$/, '');
  const clock = options.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const fetchDetails = options.fetchDetails ?? true;
  const client = createJsonClient({ serviceName: 'TenderNed', fetch: options.fetch, clock, minIntervalMs: options.minIntervalMs, timeoutMs: options.timeoutMs, maxRetries: options.maxRetries });
  const counters = { detailFailures: 0, filteredOut: 0, publicationsScanned: 0, dateBlocks: 0 };
  const getJson = (url: string, signal: AbortSignal | undefined) => client.request(url, { signal });

  const matches = (codes: unknown, wanted: string[]) =>
    Array.isArray(codes) && codes.some(entry => {
      const code = typeof record(entry)?.code === 'string' ? String(record(entry)!.code) : '';
      return wanted.some(prefix => code.startsWith(prefix));
    });

  return {
    id: TENDERNED_SOURCE_ID,
    kind: 'api',
    stats: () => ({ ...client.stats(), ...counters }),
    async fetchBatch(request: FetchBatchRequest): Promise<FetchBatchResult<TenderNedRaw>> {
      const filters = parseTenderNedFilters(request.filters, new Date(clock.now()));
      const blocks = publicationBlocks(filters);
      counters.dateBlocks = blocks.length;
      let block = 0;
      let page = 0;
      let size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.limit)));
      if (request.cursor !== null) {
        const match = /^(\d{1,5}):(\d{1,3})(?::(\d{1,2}))?$/.exec(request.cursor);
        if (!match || Number(match[2]) < 1 || Number(match[2]) > MAX_PAGE_SIZE) throw new SourceError('Invalid cursor.', 'invalid_filters');
        page = Number(match[1]);
        size = Number(match[2]);
        block = Number(match[3] ?? 0);
        if (block >= blocks.length) throw new SourceError('Invalid date-block cursor.', 'invalid_filters');
        if (size > request.limit) throw new SourceError('The batch limit is smaller than the page size this cursor was created with.', 'invalid_filters');
      }
      const range = blocks[block];
      const listUrl = `${baseUrl}/publicaties?page=${page}&size=${size}&publicatieDatumVanaf=${range.publishedFrom}&publicatieDatumTot=${range.publishedTo}${cpvQuery(filters.cpvPrefixes)}`;
      const list = record(await getJson(listUrl, request.signal));
      if (!list || !Array.isArray(list.content)) throw new SourceError('TenderNed returned an unexpected list shape.', 'invalid_response');
      counters.publicationsScanned += list.content.length;
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
            counters.detailFailures++;
            detailError = error instanceof SourceError ? `${error.code}: ${error.message}` : 'unknown';
          }
        }
        if (filters.cpvPrefixes.length > 0 && !matches(detail?.cpvCodes, filters.cpvPrefixes)) { counters.filteredOut++; continue; }
        if (filters.nutsPrefixes.length > 0 && !matches(detail?.nutsCodes, filters.nutsPrefixes)) { counters.filteredOut++; continue; }
        const link = record(publication.link)?.href;
        items.push({
          externalId: id,
          sourceUrl: typeof link === 'string' && link.startsWith(TENDERNED_ORIGIN) ? link : `${PUBLICATION_PAGE_URL}${id}`,
          fetchedAt: new Date(clock.now()).toISOString(),
          raw: { list: publication, detail, detailError },
        });
      }
      const totalPages = typeof list.totalPages === 'number' ? list.totalPages : null;
      const blockDone = list.last === true || list.content.length === 0 || (totalPages !== null && page + 1 >= totalPages);
      const exhausted = blockDone && block + 1 >= blocks.length;
      const nextCursor = blocks.length === 1 ? `${page + 1}:${size}` : `${blockDone ? 0 : page + 1}:${size}:${blockDone ? block + 1 : block}`;
      return { items, nextCursor: exhausted ? null : nextCursor, exhausted };
    },
  };
}
