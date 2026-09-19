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
}
