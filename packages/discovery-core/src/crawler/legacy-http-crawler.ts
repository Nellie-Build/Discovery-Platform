import type { DiscoveryCrawler } from './discovery-crawler.js';
import { crawlWebsite, type CrawlOptions } from './website-crawler.js';
import { fetchAndExtractPage, type SinglePageFetchOptions, type SinglePageFetchResult } from './single-page.js';
import type { CrawlResult } from './types.js';

/**
 * The original crawler behind the engine interface: serial, one page at a time, always the best
 * remaining candidate. Behaviour is unchanged — `crawl` is exactly `crawlWebsite`.
 */
export class LegacyHttpCrawler implements DiscoveryCrawler {
  readonly engine = 'legacy' as const;

  crawl<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>> {
    return crawlWebsite(website, options);
  }

  fetchPage<TFacts>(url: string, options: SinglePageFetchOptions<TFacts>): Promise<SinglePageFetchResult<TFacts>> {
    return fetchAndExtractPage(url, options);
  }
}
