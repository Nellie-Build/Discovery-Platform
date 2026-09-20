import { randomUUID } from 'node:crypto';
import type { DiscoveryCrawler } from './discovery-crawler.js';
import { createCrawlSession, type CrawlOptions } from './website-crawler.js';
import { fetchAndExtractPage, type SinglePageFetchOptions, type SinglePageFetchResult } from './single-page.js';
import type { CrawlResult, CrawlerBasicDiagnostics, CrawlerDiagnostics, CrawlerQueueDiagnostics, CrawlerRuntimeSnapshot } from './types.js';
import type { CrawlCandidate } from './candidate-ranking.js';
import { PhaseTracker, collectRuntimeSnapshot, describeError, type DescribedError } from './crawler-diagnostics.js';

// Not exported: Crawlee's own types must not leak into this package's public declarations, or every
// consumer would have to compile them (they need DOM typings).
type CrawleeModule = typeof import('@crawlee/basic');

export interface CrawleeCrawlerOptions {
  /** How many page requests may be in flight at once (1-3, default 2). The crawl delay still
   * applies between request *starts*, so this overlaps network latency with the delay; it never
   * makes the crawl faster than the site's politeness allows. */
  maxConcurrency?: number;
  /** How often Crawlee may retry a page after a transient failure (0-3, default 2). */
  maxRequestRetries?: number;
  /** Test seam: how Crawlee is loaded (must resolve to the `@crawlee/basic` module, or a copy with
   * one part replaced). Production always uses the real `@crawlee/basic`. */
  loadCrawlee?: () => Promise<unknown>;
}

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 3;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 3;

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value as number) : fallback));

/** Thrown from a request handler only to hand a transient failure back to Crawlee's retry logic. */
class TransientFetchError extends Error {}

/** A public-API read that must never break the crawl: a failed read is simply "unknown". */
async function safely<T>(read: () => Promise<T> | T): Promise<T | null> {
  try { return await read(); } catch { return null; }
}

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
 * Crawlee is loaded on first use, so the legacy engine never pays for it. Every start-up step and
 * every failure is recorded in `crawlerDiagnostics` (see types.ts), so a crawl that does not work
 * in some environment says exactly where and why.
 */
export class CrawleeCrawler implements DiscoveryCrawler {
  readonly engine = 'crawlee' as const;
  private readonly maxConcurrency: number;
  private readonly maxRequestRetries: number;
  private readonly loadCrawlee: () => Promise<unknown>;

  constructor(options: CrawleeCrawlerOptions = {}) {
    this.maxConcurrency = clamp(options.maxConcurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
    this.maxRequestRetries = clamp(options.maxRequestRetries, DEFAULT_RETRIES, 0, MAX_RETRIES);
    this.loadCrawlee = options.loadCrawlee ?? (() => import('@crawlee/basic'));
  }

  /** A single known page needs no queue: it is the same policy-checked single fetch both engines use. */
  fetchPage<TFacts>(url: string, options: SinglePageFetchOptions<TFacts>): Promise<SinglePageFetchResult<TFacts>> {
    return fetchAndExtractPage(url, options);
  }

  async crawl<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>> {
    // An invalid website is still rejected here, exactly like the legacy engine does.
    const session = createCrawlSession(website, options);
    const { maxPages } = session.limits;
    const concurrency = this.maxConcurrency;
    const retries = this.maxRequestRetries;
    const tracker = new PhaseTracker();
    tracker.mark('session_created');

    let failure: (DescribedError & { phase: string }) | undefined;
    let handlerCalls = 0;
    let runtime: CrawlerRuntimeSnapshot | undefined;
    let queueDiagnostics: CrawlerQueueDiagnostics | undefined;
    let basicDiagnostics: CrawlerBasicDiagnostics | undefined;
    /** Only the first failure is the cause; later ones are consequences. */
    const recordFailure = (phase: string, error: unknown) => {
      if (failure) return;
      failure = { phase, ...describeError(error) };
      // One compact structured line for the server log; the run statistics are the primary source.
      console.error(JSON.stringify({ event: 'crawlee_run_failed', phase, errorName: failure.crawlerErrorName,
        errorMessage: failure.crawlerErrorMessage, errorCode: failure.crawlerErrorCode }));
    };

    const byKey = new Map<string, CrawlCandidate>();
    let dispatched = 0, waiting = 0, dropped = 0, retried = 0, inFlight = 0, maxInFlight = 0;
    let firstDone = false, halted = false;
    let queue: Awaited<ReturnType<CrawleeModule['RequestQueue']['open']>> | undefined;
    let config: InstanceType<CrawleeModule['Configuration']> | undefined;
    let crawler: InstanceType<CrawleeModule['BasicCrawler']> | undefined;
    /** Small on purpose: the fewer requests wait in Crawlee's FIFO queue, the sooner a newly
     * found high-ranking page can be queued ahead of low-ranking ones. */
    const window = concurrency * 2;

    const finished = () => halted || session.halted || session.targetReached;
    function halt() {
      if (halted) return;
      halted = true;
      crawler?.stop();
    }
    async function feed() {
      while (!finished() && dispatched < maxPages && waiting < window) {
        const candidate = session.take();
        if (!candidate) return;
        session.claim(candidate.url);
        byKey.set(candidate.canonicalUrl, candidate);
        dispatched++; waiting++;
        await crawler!.addRequests([{ url: candidate.url, uniqueKey: candidate.canonicalUrl }]);
      }
    }

    try {
      runtime = await safely(collectRuntimeSnapshot) ?? undefined;
      tracker.begin('import');
      tracker.mark('import_start');
      const { BasicCrawler, RequestQueue, Configuration, log, LogLevel } = await this.loadCrawlee() as CrawleeModule;
      tracker.mark('import_ok');
      log.setLevel(LogLevel.ERROR);

      tracker.begin('configuration');
      // In-memory only: nothing is written to disk, and every crawl has its own queue.
      config = new Configuration({ persistStorage: false, systemInfoIntervalMillis: 30_000 });
      tracker.mark('configuration_created');

      tracker.begin('queue_open');
      queue = await RequestQueue.open(`discovery-${randomUUID()}`, { config });
      tracker.mark('queue_opened');

      tracker.begin('crawler_create');
      crawler = new BasicCrawler({
        requestQueue: queue,
        maxConcurrency: concurrency,
        minConcurrency: 1,
        maxRequestRetries: retries,
        requestHandlerTimeoutSecs: 120,
        useSessionPool: false,
        autoscaledPoolOptions: { desiredConcurrency: concurrency, loggingIntervalSecs: null },
        async requestHandler({ request }) {
          handlerCalls++;
          if (handlerCalls === 1) tracker.mark('request_handler_started');
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
            recordFailure('request_handler', error);
            session.fail(error);
            halt();
            return;
          } finally {
            inFlight--;
            if (!retrying) waiting--;
          }
          if (finished()) { halt(); return; }
          try { await feed(); } catch (error) { recordFailure('request_feed', error); throw error; }
        },
        // Retries are exhausted: the attempts are already recorded; just release the slot.
        failedRequestHandler(_context, error) { recordFailure('request_failed', error); waiting--; },
      }, config);
      tracker.mark('crawler_created');

      tracker.begin('seed');
      const first = session.seed();
      session.claim(first.url);
      byKey.set(first.canonicalUrl, first);
      dispatched++; waiting++;
      const seed = { url: first.url, uniqueKey: first.canonicalUrl };
      const before = await safely(() => queue!.getInfo());
      const publicState = crawler as unknown as { running?: boolean; hasFinishedBefore?: boolean; autoscaledPool?: unknown };
      queueDiagnostics = {
        seedUrlPresent: typeof seed.url === 'string' && seed.url.length > 0,
        seedUniqueKeyPresent: typeof seed.uniqueKey === 'string' && seed.uniqueKey.length > 0,
        queueOpened: true,
        totalBefore: before?.totalRequestCount ?? null, pendingBefore: before?.pendingRequestCount ?? null, handledBefore: before?.handledRequestCount ?? null,
      };
      basicDiagnostics = { runningBeforeRun: publicState.running, hasFinishedBefore: publicState.hasFinishedBefore, autoscaledPoolCreated: Boolean(publicState.autoscaledPool) };

      tracker.begin('run');
      tracker.mark('run_started');
      await crawler.run([seed]);
      tracker.mark('run_completed');
      // The run finished, yet no page was ever handed to the request handler: report it as such
      // rather than as a site with nothing to crawl.
      if (handlerCalls === 0 && !session.halted) {
        tracker.begin('run_no_requests');
        const error = new Error('crawler.run() completed without ever calling the request handler.');
        error.name = 'CrawleeNoRequestsProcessed';
        recordFailure('run_no_requests', error);
        session.fail(error);
      }
    } catch (error) {
      const phase = tracker.operation;
      tracker.mark('run_failed');
      recordFailure(phase, error);
      session.fail(error);
    } finally {
      const after = queue ? await safely(() => queue!.getInfo()) : null;
      if (queueDiagnostics && after) {
        queueDiagnostics.totalAfter = after.totalRequestCount ?? null;
        queueDiagnostics.pendingAfter = after.pendingRequestCount ?? null;
        queueDiagnostics.handledAfter = after.handledRequestCount ?? null;
      }
      if (basicDiagnostics && crawler) {
        const state = crawler as unknown as { running?: boolean; autoscaledPool?: unknown };
        basicDiagnostics.runningAfterRun = state.running;
        basicDiagnostics.autoscaledPoolCreatedAfterRun = Boolean(state.autoscaledPool);
      }
      await queue?.drop().catch(() => undefined);
      await config?.getEventManager().close().catch(() => undefined);
    }

    const diagnostics: CrawlerDiagnostics = {
      crawlerPhase: tracker.lastPhase,
      crawlerPhases: tracker.phases,
      crawlerRequestHandlerCalls: handlerCalls,
      ...(failure ? {
        crawlerFailurePhase: failure.phase, crawlerErrorName: failure.crawlerErrorName, crawlerErrorMessage: failure.crawlerErrorMessage,
        ...(failure.crawlerErrorCode ? { crawlerErrorCode: failure.crawlerErrorCode } : {}),
        ...(failure.crawlerErrorCause ? { crawlerErrorCause: failure.crawlerErrorCause } : {}),
        ...(failure.crawlerErrorStack ? { crawlerErrorStack: failure.crawlerErrorStack } : {}),
      } : {}),
      ...(queueDiagnostics ? { crawlerQueue: queueDiagnostics } : {}),
      ...(basicDiagnostics ? { crawlerBasicCrawler: basicDiagnostics } : {}),
      ...(runtime ? { crawlerRuntime: runtime } : {}),
    };
    return { ...session.finish({ engine: 'crawlee', maxConcurrencyUsed: maxInFlight, requestsRetried: retried, extraQueueRemaining: waiting + dropped }),
      crawlerDiagnostics: diagnostics };
  }
}
