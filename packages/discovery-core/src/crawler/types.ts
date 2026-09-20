import type { ExtractedContacts } from '../extract/contacts.js';

export type CrawlStatus = 'succeeded' | 'partial' | 'blocked' | 'failed';

/**
 * Why the crawl's own main loop stopped — always reported, never left implicit. `targetReached`
 * only ever happens when the caller supplied `shouldContinue` (see CrawlOptions) and it returned
 * false; this package has no concept of a "record" or a "target" itself. `noMoreCandidates` is
 * the natural-completion case: every discovered link was visited (or excluded) and nothing new
 * was found to queue.
 */
export type CrawlStopReason =
  | 'target_reached' | 'no_more_candidates' | 'page_limit' | 'candidate_limit'
  | 'time_limit' | 'rate_limited' | 'robots_blocked';

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
  candidateScore?: number;
  candidateReasons?: string[];
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
  discoveryStats: {
    urlsDiscovered: number;
    uniqueUrlsDiscovered: number;
    /** Distinct crawl identities among the unique URLs: variants the domain identifies as one record count once. */
    uniqueCrawlIdentities: number;
    /** Unique URLs that are only another address of an already-known identity (`uniqueUrlsDiscovered - uniqueCrawlIdentities`). */
    candidateIdentityDuplicates: number;
    sitemapUrlsFound: number;
    sitemapCandidatesAccepted: number;
    sitemapCandidatesRejected: number;
    listingUrlsFound: number;
    candidateUrlsFound: number;
    highConfidenceCandidates: number;
    mediumConfidenceCandidates: number;
    lowConfidenceCandidates: number;
    candidatesProcessed: number;
    candidatesRemaining: number;
    knownCandidates: number;
    newCandidates: number;
    unchangedCandidates: number;
  };
  candidates: import('./candidate-ranking.js').CrawlCandidate[];
  status: CrawlStatus;
  homepage: string;
  domain: string;
  pagesVisited: number;
  httpStatus: number | null;
  error: string | null;
  records: CrawlRecord[];
  contacts: ExtractedContacts;
  extractedPages: ExtractedPage<TFacts>[];
  /** Why the main crawl loop stopped — see CrawlStopReason's own doc comment. */
  stopReason: CrawlStopReason;
  /** How many distinct URLs were ever queued as a candidate to visit — including ones never
   * actually fetched (page budget/candidate cap/target reached first). A caller reporting its own
   * "candidates discovered" stat reads this rather than re-deriving it. */
  candidatesDiscovered: number;
  /** True when the candidate cap (`CrawlOptions.maxCandidates`) was ever hit — i.e. at least one
   * discovered link had to be dropped because the candidate list was already full. Distinguishes
   * a genuine `candidate_limit` stop from a crawl that simply ran out of links on its own. */
  candidateLimitReached: boolean;
  /** How the crawl engine itself behaved (queueing, requests, retries, concurrency). Both engines
   * report it; optional so results built by older callers remain valid. */
  crawlerStats?: CrawlerRunStats;
  /** Start-up and failure diagnostics of a queue-driven engine (absent for the legacy engine). */
  crawlerDiagnostics?: CrawlerDiagnostics;
}

/** Which crawl engine ran. `legacy` is the original serial HTTP crawler, `crawlee` the
 * queue-driven one built on Crawlee's request queue and retry handling. */
export type CrawlerEngineName = 'legacy' | 'crawlee';

/** Engine-level figures, identical in meaning for every engine so runs can be compared. The
 * request counts cover every HTTP request the crawl made (pages, robots.txt, sitemaps). */
export interface CrawlerRunStats {
  crawlerEngine: CrawlerEngineName;
  /** Distinct in-scope URLs the crawl ever queued as a candidate. */
  requestsQueued: number;
  requestsStarted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  /** Page requests that were tried again after a transient failure. */
  requestsRetried: number;
  /** The most page requests in flight at the same time. */
  maxConcurrencyUsed: number;
  /** Candidates still waiting when the crawl ended. */
  queueRemaining: number;
  durationMs: number;
}

/** Facts about the environment a crawl engine runs in — booleans and plain numbers only. */
export interface CrawlerRuntimeSnapshot {
  nodeVersion: string;
  platform: string;
  arch: string;
  procReadable: boolean;
  cgroupReadable: boolean;
  tmpWritable: boolean;
  cwdWritable: boolean;
  storageDirPresent: boolean;
  osTotalMemoryMb: number;
  /** The container memory limit from the cgroup files, when one is set and readable. */
  memoryLimitDetectedMb: number | null;
}

export interface CrawlerQueueDiagnostics {
  seedUrlPresent: boolean;
  seedUniqueKeyPresent: boolean;
  queueOpened: boolean;
  totalBefore?: number | null;
  pendingBefore?: number | null;
  handledBefore?: number | null;
  totalAfter?: number | null;
  pendingAfter?: number | null;
  handledAfter?: number | null;
}

export interface CrawlerBasicDiagnostics {
  runningBeforeRun?: boolean;
  hasFinishedBefore?: boolean;
  /** Whether the autoscaled pool existed before `run()` (it is normally created by it). */
  autoscaledPoolCreated: boolean;
  autoscaledPoolCreatedAfterRun?: boolean;
  runningAfterRun?: boolean;
}

/**
 * Why (and how far) a queue-driven engine got, kept in the run statistics. `crawlerFailurePhase` is
 * the operation that was in progress when something went wrong: `import`, `configuration`,
 * `queue_open`, `crawler_create`, `seed`, `run`, `request_handler`, `request_feed`,
 * `request_failed` (retries exhausted) or `run_no_requests` (the run finished without ever calling
 * the request handler). Absent when nothing went wrong.
 */
export interface CrawlerDiagnostics {
  crawlerPhase: string;
  crawlerPhases: { phase: string; ms: number }[];
  crawlerRequestHandlerCalls: number;
  crawlerFailurePhase?: string;
  crawlerErrorName?: string;
  crawlerErrorMessage?: string;
  crawlerErrorCode?: string;
  crawlerErrorCause?: string;
  crawlerErrorStack?: string;
  crawlerQueue?: CrawlerQueueDiagnostics;
  crawlerBasicCrawler?: CrawlerBasicDiagnostics;
  crawlerRuntime?: CrawlerRuntimeSnapshot;
}
