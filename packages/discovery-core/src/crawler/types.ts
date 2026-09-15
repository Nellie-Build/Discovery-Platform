import type { ExtractedContacts } from '../extract/contacts.js';

export type CrawlStatus = 'succeeded' | 'partial' | 'blocked' | 'failed';

/** One fetched (or blocked/failed) request the crawler made — a page, a robots.txt lookup, or a
 * sitemap fetch. Domain-neutral: nothing here describes what was found on the page, only what
 * happened when the crawler tried to reach it. */
export interface CrawlRecord {
  sequence: number;
  kind: 'page' | 'robots' | 'sitemap';
  url: string;
  attempted: boolean;
  status: 'ok' | 'http_error' | 'redirect' | 'blocked' | 'failed';
  httpStatus: number | null;
  fetchedAt: string;
  durationMs: number;
  contentType: string | null;
  bytes: number;
  title: string | null;
  sha256: string | null;
  redirectTo: string | null;
  error: string | null;
}

/** One page's domain-specific facts, exactly as the caller's own `extract` callback returned
 * them — the crawler never inspects or merges this data itself. */
export interface ExtractedPage<TFacts> {
  url: string;
  data: TFacts;
  isHomepage: boolean;
}

/**
 * The crawl's outcome. `extractedPages` is intentionally raw and per-page — merging duplicate
 * facts found on different pages (e.g. "which page's bedroom count wins?") is business logic
 * that belongs to the domain calling this, never to the generic crawler.
 */
export interface CrawlResult<TFacts> {
  status: CrawlStatus;
  homepage: string;
  domain: string;
  pagesVisited: number;
  httpStatus: number | null;
  error: string | null;
  records: CrawlRecord[];
  contacts: ExtractedContacts;
  extractedPages: ExtractedPage<TFacts>[];
}
