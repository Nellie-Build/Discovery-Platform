import { randomUUID } from 'node:crypto';
import type { DiscoveryCrawler } from './discovery-crawler.js';
import { createCrawlSession, type CrawlOptions } from './website-crawler.js';
import { fetchAndExtractPage, type SinglePageFetchOptions, type SinglePageFetchResult } from './single-page.js';
import type { CrawlResult } from './types.js';
import type { CrawlCandidate } from './candidate-ranking.js';

export interface CrawleeCrawlerOptions {
  /** How many page requests may be in flight at once (1-3, default 2). The crawl delay still
   * applies between request *starts*, so this overlaps network latency with the delay; it never
   * makes the crawl faster than the site's politeness allows. */
  maxConcurrency?: number;
  /** How often Crawlee may retry a page after a transient failure (0-3, default 2). */
  maxRequestRetries?: number;
}

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 3;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 3;

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value as number) : fallback));

/** Thrown from a request handler only to hand a transient failure back to Crawlee's retry logic. */
class TransientFetchError extends Error {}

/**
 * A crawl engine built on Crawlee's request queue, retry handling and concurrency control. It is
 * deliberately *not* Crawlee's own HTTP crawler: Crawlee's `BasicCrawler` only schedules requests,
 * and every fetch still goes through `createCrawlSession().crawlPage` — our scope rules, robots.txt,
 * crawl delay, redirect validation, size limit and SSRF-safe transport. Only URLs that already
 * passed our normalisation ever reach Crawlee's queue.
 *
 * Priority: Crawlee's queue is first-in-first-out. The caller's candidate ranking stays the one
 * source of ordering (the session's `CandidateQueue`); this engine tops Crawlee's queue up from it
 * in small batches, always with the best-ranked candidates first. The requested page is queued
 * alone and finishes (with the sitemap lookup) before any other page is queued.
 *
 * Crawlee is loaded on first use, so the legacy engine never pays for it.
 */
export class CrawleeCrawler implements DiscoveryCrawler {
  readonly engine = 'crawlee' as const;
  private readonly maxConcurrency: number;
  private readonly maxRequestRetries: number;

  constructor(options: CrawleeCrawlerOptions = {}) {
    this.maxConcurrency = clamp(options.maxConcurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
    this.maxRequestRetries = clamp(options.maxRequestRetries, DEFAULT_RETRIES, 0, MAX_RETRIES);
  }

  /** A single known page needs no queue: it is the same policy-checked single fetch both engines use. */
  fetchPage<TFacts>(url: string, options: SinglePageFetchOptions<TFacts>): Promise<SinglePageFetchResult<TFacts>> {
    return fetchAndExtractPage(url, options);
  }

  async crawl<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>> {
    const { BasicCrawler, RequestQueue, Configuration, log, LogLevel } = await import('@crawlee/basic');
    log.setLevel(LogLevel.ERROR);
    const session = createCrawlSession(website, options);
    const { maxPages } = session.limits;
    const concurrency = this.maxConcurrency;
    // In-memory only: nothing is written to disk, and every crawl has its own queue.
    const config = new Configuration({ persistStorage: false, systemInfoIntervalMillis: 30_000 });
    const queue = await RequestQueue.open(`discovery-${randomUUID()}`, { config });
    const byKey = new Map<string, CrawlCandidate>();
    /** Small on purpose: the fewer requests wait in Crawlee's FIFO queue, the sooner a newly
     * found high-ranking page can be queued ahead of low-ranking ones. */
    const window = concurrency * 2;
    let dispatched = 0, waiting = 0, dropped = 0, retried = 0, inFlight = 0, maxInFlight = 0;
    let firstDone = false, halted = false;
    const retries = this.maxRequestRetries;
    let crawler!: InstanceType<typeof BasicCrawler>;

    const finished = () => halted || session.halted || session.targetReached;
    function halt() {
      if (halted) return;
      halted = true;
      crawler.stop();
    }
    async function feed() {
      while (!finished() && dispatched < maxPages && waiting < window) {
        const candidate = session.take();
        if (!candidate) return;
        session.claim(candidate.url);
        byKey.set(candidate.canonicalUrl, candidate);
        dispatched++; waiting++;
        await crawler.addRequests([{ url: candidate.url, uniqueKey: candidate.canonicalUrl }]);
      }
    }

    crawler = new BasicCrawler({
      requestQueue: queue,
      maxConcurrency: concurrency,
      minConcurrency: 1,
      maxRequestRetries: this.maxRequestRetries,
      requestHandlerTimeoutSecs: 120,
      useSessionPool: false,
      autoscaledPoolOptions: { desiredConcurrency: concurrency, loggingIntervalSecs: null },
      async requestHandler({ request }) {
        const candidate = byKey.get(request.uniqueKey);
        if (!candidate || finished()) { waiting--; dropped++; return; }
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        let retrying = false;
        try {
          const attempt = await session.crawlPage(candidate);
          if (attempt.transient && !session.halted && request.retryCount < retries) {
            retrying = true; retried++;
            throw new TransientFetchError(`HTTP-verzoek mislukt: ${attempt.httpStatus ?? 'netwerkfout'}`);
          }
          session.markProcessed();
          if (!session.keepGoing()) { halt(); return; }
          if (!firstDone) { firstDone = true; await session.discoverSitemap(candidate.url); }
        } catch (error) {
          if (error instanceof TransientFetchError) throw error;
          // An unexpected failure ends the crawl the same way it does in the legacy engine.
          session.fail(error);
          halt();
          return;
        } finally {
          inFlight--;
          if (!retrying) waiting--;
        }
        if (finished()) { halt(); return; }
        await feed();
      },
      // Retries are exhausted: the attempts are already recorded; just release the slot.
      failedRequestHandler() { waiting--; },
    }, config);

    try {
      const first = session.seed();
      session.claim(first.url);
      byKey.set(first.canonicalUrl, first);
      dispatched++; waiting++;
      await crawler.run([{ url: first.url, uniqueKey: first.canonicalUrl }]);
    } catch (error) {
      session.fail(error);
    } finally {
      await queue.drop().catch(() => undefined);
      await config.getEventManager().close().catch(() => undefined);
    }
    return session.finish({ engine: 'crawlee', maxConcurrencyUsed: maxInFlight, requestsRetried: retried, extraQueueRemaining: waiting + dropped });
  }
}
