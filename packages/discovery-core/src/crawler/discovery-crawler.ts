import type { CrawlOptions } from './website-crawler.js';
import type { CrawlResult, CrawlerEngineName } from './types.js';
import type { SinglePageFetchOptions, SinglePageFetchResult } from './single-page.js';
import { LegacyHttpCrawler } from './legacy-http-crawler.js';
import { CrawleeCrawler, type CrawleeCrawlerOptions } from './crawlee-crawler.js';

/**
 * A domain-neutral crawl engine. It explores one website (`crawl`) or fetches exactly one page
 * (`fetchPage`) and hands every HTML page to the caller's own `extract` callback; it knows nothing
 * about what is being looked for. Both engines return the same `CrawlResult`, so everything after
 * the crawl (extraction, scoring, de-duplication, persistence) is engine-independent.
 *
 * Every engine fetches through the same policy layer (scope, robots.txt, crawl delay, redirects,
 * size limits, SSRF-safe transport): an engine only decides *when* a page is fetched, never
 * *whether* it may be.
 */
export interface DiscoveryCrawler {
  readonly engine: CrawlerEngineName;
  crawl<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>>;
  fetchPage<TFacts>(url: string, options: SinglePageFetchOptions<TFacts>): Promise<SinglePageFetchResult<TFacts>>;
}

export const DEFAULT_CRAWLER_ENGINE: CrawlerEngineName = 'legacy';

/** Reads a server-side engine setting (e.g. `DISCOVERY_CRAWLER_ENGINE`). Anything other than an
 * explicit `crawlee` is the legacy engine — a typo can never switch engines by accident. */
export function parseCrawlerEngine(value: string | undefined | null): CrawlerEngineName {
  return value?.trim().toLowerCase() === 'crawlee' ? 'crawlee' : DEFAULT_CRAWLER_ENGINE;
}

export type DiscoveryCrawlerOptions = CrawleeCrawlerOptions;

export function createDiscoveryCrawler(engine: CrawlerEngineName = DEFAULT_CRAWLER_ENGINE, options: DiscoveryCrawlerOptions = {}): DiscoveryCrawler {
  return engine === 'crawlee' ? new CrawleeCrawler(options) : new LegacyHttpCrawler();
}
