import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadBuffer, type CheerioAPI } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
// robots-parser ships a self-referencing ambient module declaration that breaks
// TS's NodeNext default-import typing, so load the CJS export directly instead.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, robotstxt: string) => Robot;
import { fetchPublicUrl, type HttpTransport, type HttpResult } from './http.js';
import { websiteScope, linkPriority, type PriorityTier } from './url-policy.js';
import { extractContacts, mergeContacts, type ExtractedContacts, type ContactNormalizers } from '../extract/contacts.js';
import type { CrawlRecord, CrawlResult, CrawlStopReason, CrawlerRunStats, ExtractedPage } from './types.js';
import { CandidateQueue, type CandidateEvidence, type CandidateRank, type CrawlCandidate } from './candidate-ranking.js';

export const CRAWL_POLICY = {
  userAgent: 'DiscoveryCoreBot/1.0', maxPages: 10, maxMetadataRequests: 8,
  minDelayMs: 2000, maxRedirects: 3, maxDurationMs: 300_000,
  /** A caller-supplied `maxPages`/`maxCandidates` is always clamped to these — defense in depth,
   * never relying only on the caller (e.g. apps/api) to have validated user input. This package
   * has no notion of "targetRecords" itself, only of pages/candidates/time, so these ceilings are
   * deliberately generous rather than product-specific. */
  absoluteMaxPages: 300, absoluteMaxCandidates: 1000,
};

/** Everything a domain's own `extract` callback gets to look at for one successfully fetched
 * HTML page — the parsed document, plus the two things this package already knows how to
 * compute generically (which page-category priority this URL falls into, and its own contact
 * details) so the domain never needs to recompute them. */
export interface CrawlPage {
  $: CheerioAPI;
  url: string;
  isHomepage: boolean;
  /** This page's own linkPriority() ranking (see url-policy.ts) — lower means the crawler
   * considered it more likely to be a genuinely useful page (contact/about/reservation/...).
   * A domain can use this to decide, itself, which pages it trusts for its own numeric/detail
   * extraction — this package has no opinion on that threshold. */
  priority: number;
  contacts: ExtractedContacts;
}

export interface CrawlOptions<TFacts> {
  rankCandidate?: (evidence: CandidateEvidence) => CandidateRank;
  /** Optional prior-run evidence; absence never means a URL was unchanged. */
  knownCandidates?: ReadonlyMap<string, string | null>;
  /**
   * Pages the caller has already fetched itself (for example as a search result): the crawl never queues or requests
   * them again. The page the crawl starts from is always fetched, whatever this contains.
   */
  skipUrls?: Iterable<string>;
  /**
   * The one seam that makes this crawler domain-neutral: called once per successfully fetched
   * HTML page, with everything above already computed. Returns whatever facts the domain cares
   * about for that page — one, several (e.g. one per structured-data node found on the page),
   * or `undefined` for "nothing found here". This package never inspects, scores, or merges the
   * returned facts; combining what several pages said is the domain's own responsibility.
   */
  extract: (page: CrawlPage) => TFacts | TFacts[] | undefined;
  /** How to turn a raw phone/e-mail string into a normalized one — deliberately not built into
   * this package (see extract/contacts.ts's own doc comment for why). */
  contactNormalizers: ContactNormalizers;
  /** Extra page-category tiers (see url-policy.ts's linkPriority) a domain wants considered
   * during crawl-order ranking and reflected in `CrawlPage.priority` — e.g. "does this URL look
   * like a room/unit detail page" for an accommodation domain. Defaults to none. */
  linkPriorityExtraTiers?: PriorityTier[];
  userAgent?: string;
  expectedName?: string | null;
  maxDurationMs?: number;
  /** How many pages this one crawl may fetch — defaults to `CRAWL_POLICY.maxPages` (10) when
   * unset, exactly like before. Always clamped to `CRAWL_POLICY.absoluteMaxPages`, regardless of
   * what a caller passes — this package is never the last line of defense against runaway input,
   * but it never blindly trusts it either. */
  maxPages?: number;
  /** How many distinct candidate URLs this crawl may ever queue at once — defaults to 500,
   * exactly like before. Clamped to `CRAWL_POLICY.absoluteMaxCandidates`. */
  maxCandidates?: number;
  /**
   * Called once after every successfully extracted page, with every `ExtractedPage` gathered so
   * far — return `false` to stop the crawl early (the run's `stopReason` becomes
   * `'target_reached'`). This package has no concept of a "valid" or "duplicate" record; the
   * caller decides that (typically via its own dedupe/validation against a target record count)
   * and simply tells the crawler whether continuing is still worthwhile. Omit to crawl until
   * another stop condition (page/candidate/time limit, or no more candidates) is reached, exactly
   * like before this option existed.
   */
  shouldContinue?: (extractedSoFar: ExtractedPage<TFacts>[]) => boolean;
  transport?: HttpTransport;
  onRecord?: (record: CrawlRecord) => Promise<void>;
  // Injectable clock for deterministic tests; the CLI always uses real time.
  clock?: { now(): number; sleep(ms: number): Promise<unknown> };
}

/** What one attempt to fetch and process a single page ended in. `transient` is true only when a
 * retry could plausibly help (a network failure/timeout or an HTTP 5xx) — never for a refusal by
 * our own policy (robots, scope, non-public address, size limit) or a rate-limit stop. */
export interface CrawlAttempt {
  fetched: boolean;
  httpStatus: number | null;
  transient: boolean;
}

/** Engine-specific figures a crawler engine adds to the shared result (see `CrawlerRunStats`). */
export interface SessionFinishInfo {
  engine: CrawlerRunStats['crawlerEngine'];
  maxConcurrencyUsed: number;
  requestsRetried: number;
  /** Requests an engine still holds in its own dispatch buffer (not yet started). */
  extraQueueRemaining?: number;
}

/**
 * One website crawl's shared state and every policy-bearing step: URL scope, robots.txt, crawl
 * delay, redirects, request/time/page budgets, candidate ranking, sitemap discovery, extraction and
 * result building. Engines differ only in how they *schedule* pages (see `crawlWebsite` below for
 * the original serial loop, and crawlee-crawler.ts for a queue-driven one) — every URL an engine
 * fetches goes through `crawlPage`, so security and politeness can never differ between engines.
 *
 * Safe for a small number of concurrent `crawlPage` calls: page budget and the request slot are
 * reserved synchronously, before any wait.
 */
export function createCrawlSession<TFacts>(website: string, options: CrawlOptions<TFacts>) {
  const scope = websiteScope(website);
  const transport = options.transport ?? fetchPublicUrl;
  const clock = options.clock ?? { now: Date.now, sleep };
  const userAgent = options.userAgent ?? CRAWL_POLICY.userAgent;
  const linkPriorityExtraTiers = options.linkPriorityExtraTiers ?? [];
  const start = clock.now();
  const maxDurationMs = Math.min(CRAWL_POLICY.maxDurationMs, options.maxDurationMs ?? CRAWL_POLICY.maxDurationMs);
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error('Ongeldige crawl-tijdslimiet.');
  const maxPages = Math.min(CRAWL_POLICY.absoluteMaxPages, Math.max(1, Math.floor(options.maxPages ?? CRAWL_POLICY.maxPages)));
  const maxCandidates = Math.min(CRAWL_POLICY.absoluteMaxCandidates, Math.max(1, Math.floor(options.maxCandidates ?? 500)));
  if (!Number.isFinite(maxPages) || !Number.isFinite(maxCandidates)) throw new Error('Ongeldige crawl-limiet.');
  // When the last request was allowed to start: every request (page, robots, sitemap) reserves the
  // slot one crawl delay after the previous one, so the delay holds however many pages are in flight.
  let lastSlot = -Infinity, delay = CRAWL_POLICY.minDelayMs;
  let pages = 0, metadata = 0, stopped: string | null = null;
  let stopReasonCode: CrawlStopReason | null = null;
  let candidateLimitReached = false;
  let homepageStatus: number | null = null, homepageBlocked = false;
  const records: CrawlRecord[] = [], visited = new Set<string>();
  for (const skipped of options.skipUrls ?? []) {
    const normalized = scope.normalize(skipped);
    if (normalized && normalized !== scope.requestedPage) visited.add(normalized);
  }
  const contactPages: { url: string; contacts: ExtractedContacts }[] = [];
  const extractedPages: ExtractedPage<TFacts>[] = [];
  const candidates = new CandidateQueue(maxCandidates);
  const candidateEvidence = new Map<string, CrawlCandidate>();
  /** Canonical URL → the domain's identity key, for URLs that have one (never exposed per candidate). */
  const identities = new Map<string, string>();
  let urlsDiscovered = 0, sitemapUrlsFound = 0, listingUrlsFound = 0, candidatesProcessed = 0;
  let sitemapCandidatesAccepted = 0, sitemapCandidatesRejected = 0;
  const unchanged = new Set<string>();
  /** Every distinct, in-scope URL ever discovered via a link or sitemap entry — never shrinks,
   * unlike `candidates` (which loses an entry once visited/dequeued). Powers `candidatesDiscovered`
   * in the final result. */
  const discoveredUrls = new Set<string>();
  const robots = new Map<string, Promise<{ parser: ReturnType<typeof robotsParser>; error: string | null }>>();
  let checkedSitemap = false;
  const errors: string[] = [];

  /** Per-fetch context, so concurrent page fetches never overwrite each other's bookkeeping. */
  interface FetchContext { candidate?: CrawlCandidate; httpStatus: number | null; transient: boolean }

  async function record(value: Omit<CrawlRecord, 'sequence'>, candidate?: CrawlCandidate) {
    const entry = { ...value, ...(value.kind === 'page' && candidate ? {
      candidateScore: candidate.candidateScore, candidateReasons: candidate.candidateReasons,
    } : {}), sequence: records.length + 1 };
    if (value.kind === 'page' && value.sha256 && options.knownCandidates?.get(value.url) === value.sha256) unchanged.add(value.url);
    records.push(entry);
    await options.onRecord?.(entry);
  }
  function blank(url: string, kind: CrawlRecord['kind']): Omit<CrawlRecord, 'sequence'> {
    return { url, kind, attempted: false, status: 'blocked', httpStatus: null,
      fetchedAt: new Date(clock.now()).toISOString(), durationMs: 0, contentType: null,
      bytes: 0, title: null, sha256: null, redirectTo: null, error: null };
  }
  async function denied(url: string, kind: CrawlRecord['kind'], error: string, context?: FetchContext) {
    await record({ ...blank(url, kind), error }, context?.candidate);
    if (kind === 'page') errors.push(error);
  }
  function add(input: string, base: string, label = '', source: CandidateEvidence['source'] = 'link'): boolean {
    urlsDiscovered++;
    if (source === 'sitemap') sitemapUrlsFound++;
    if (source === 'listing') listingUrlsFound++;
    const url = scope.normalize(input, base);
    if (!url) { if (source === 'sitemap') sitemapCandidatesRejected++; return false; }
    discoveredUrls.add(url);
    const evidence = { url, source, label, discoveredFrom: base };
    const rank = options.rankCandidate?.(evidence) ?? {
      score: 100 - linkPriority(url, label, linkPriorityExtraTiers) * 10,
      reasons: ['link_priority'], classification: 'general' as const,
    };
    const candidate: CrawlCandidate = { ...evidence, canonicalUrl: url, candidateScore: rank.score,
      candidateReasons: rank.reasons, classification: rank.classification };
    if (rank.dedupeKey) identities.set(url, rank.dedupeKey);
    const previous = candidateEvidence.get(url);
    if (!previous || previous.candidateScore < candidate.candidateScore) candidateEvidence.set(url, candidate);
    if (visited.has(url)) { if (source === 'sitemap') sitemapCandidatesAccepted++; return true; }
    const accepted = candidates.offer(candidateEvidence.get(url)!, identities.get(url));
    candidateLimitReached = candidates.limitReached;
    if (source === 'sitemap') { if (accepted) sitemapCandidatesAccepted++; else sitemapCandidatesRejected++; }
    return accepted;
  }

  async function policy(url: string) {
    const origin = new URL(url).origin;
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        const robotsUrl = `${origin}/robots.txt`;
        const result = await get(robotsUrl, 'robots');
        let body = '', error: string | null = null;
        if (!result || ![200, 404, 410].includes(result.response.status)) {
          body = 'User-agent: *\nDisallow: /';
          error = 'robots.txt kon niet betrouwbaar worden gelezen; crawl geblokkeerd.';
        } else if (result.response.status === 200) body = result.response.body.toString('utf8');
        const parser = robotsParser(robotsUrl, body);
        const crawlDelay = parser.getCrawlDelay(userAgent);
        if (crawlDelay !== undefined && Number.isFinite(crawlDelay) && crawlDelay >= 0) delay = Math.max(delay, crawlDelay * 1000);
        return { parser, error };
      })());
    }
    return robots.get(origin)!;
  }

  /** A network failure, timeout or 5xx may be worth retrying; a refusal by our own policy is not. */
  const isTransientFailure = (message: string) => !/Niet-publiek netwerkadres|groter dan/i.test(message);

  async function get(initial: string, kind: CrawlRecord['kind'], context?: FetchContext): Promise<{ response: HttpResult; url: string } | null> {
    let url = initial;
    const chain = new Set<string>();
    for (let hop = 0; hop <= CRAWL_POLICY.maxRedirects; hop++) {
      if (!scope.normalize(url, undefined, false)) { await denied(url, kind, 'URL buiten het toegestane domein.', context); return null; }
      if (chain.has(url)) { await denied(url, kind, 'Redirectlus gestopt.', context); return null; }
      chain.add(url);
      if (stopped) { await denied(url, kind, stopped, context); return null; }
      if (kind !== 'robots') {
        const rule = await policy(url);
        if (rule.error || rule.parser.isAllowed(url, userAgent) === false) {
          await denied(url, kind, rule.error ?? 'Geblokkeerd door robots.txt.', context);
          return null;
        }
      }
      if (stopped) { await denied(url, kind, stopped, context); return null; }
      if ((kind === 'page' ? pages >= maxPages : metadata >= CRAWL_POLICY.maxMetadataRequests)) {
        await denied(url, kind, 'Verzoeklimiet bereikt.', context); return null;
      }
      const slot = Math.max(clock.now(), lastSlot + delay);
      const wait = Math.max(0, slot - clock.now());
      if (clock.now() + wait - start >= maxDurationMs) {
        stopped = 'Tijdslimiet bereikt; vereiste crawl-delay wordt niet verkort.';
        stopReasonCode = 'time_limit';
        await denied(url, kind, stopped, context); return null;
      }
      // Reserve the page/request budget and the next request slot before waiting, so concurrent
      // fetches can neither exceed the budget nor start closer together than the crawl delay.
      lastSlot = slot;
      if (kind === 'page') { pages++; visited.add(url); } else metadata++;
      if (wait) await clock.sleep(wait);
      const requestStart = clock.now();
      let response: HttpResult;
      try { response = await transport(url, userAgent); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (context) { context.httpStatus = null; context.transient = isTransientFailure(message); }
        await record({ ...blank(url, kind), attempted: true, status: 'failed', durationMs: clock.now() - requestStart, error: message }, context?.candidate);
        if (kind === 'page') errors.push(message);
        return null;
      }
      const redirect = [301, 302, 303, 307, 308].includes(response.status);
      const location = response.headers.location;
      const destination = redirect && location ? scope.normalize(location, url, false) : null;
      const contentType = response.headers['content-type'] ?? null;
      let title: string | null = null;
      if (kind === 'page' && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType ?? '')) {
        title = loadBuffer(response.body)('title').first().text().trim().slice(0, 500) || null;
      }
      let error: string | null = response.status >= 400 ? `HTTP ${response.status}` : null;
      if (redirect && !destination) error = 'Redirect zonder geldige bestemming binnen het toegestane domein.';
      if (redirect && hop === CRAWL_POLICY.maxRedirects) error = 'Maximum aantal redirects bereikt.';
      if (context) { context.httpStatus = response.status; context.transient = response.status >= 500 && response.status !== 503; }
      await record({ ...blank(url, kind), attempted: true,
        status: error ? 'http_error' : redirect ? 'redirect' : 'ok', httpStatus: response.status,
        durationMs: clock.now() - requestStart, contentType, bytes: response.body.length, title,
        sha256: createHash('sha256').update(response.body).digest('hex'), redirectTo: destination, error }, context?.candidate);
      if (kind === 'page' && error) errors.push(error);
      if ([429, 503].includes(response.status)) {
        stopped = `HTTP ${response.status}: website vraagt om rust; verdere verzoeken gestopt.`;
        stopReasonCode = 'rate_limited';
      }
      if (redirect) {
        if (error || !destination) return null;
        url = destination;
        continue;
      }
      return { response, url };
    }
    return null;
  }

  async function sitemap(home: string) {
    const pending = [new URL('/sitemap.xml', home).href];
    const rule = await policy(home);
    pending.push(...rule.parser.getSitemaps());
    const done = new Set<string>();
    const parser = new XMLParser({ ignoreAttributes: true, processEntities: false, parseTagValue: false, removeNSPrefix: true });
    while (pending.length && metadata < CRAWL_POLICY.maxMetadataRequests && !stopped) {
      const url = scope.normalize(pending.shift()!, home, false);
      if (!url || done.has(url)) continue;
      done.add(url);
      const result = await get(url, 'sitemap');
      if (!result) continue;
      // A sitemap that redirected is the same document as its destination ("/sitemap.xml" → the index
      // robots.txt also names): never spend a second request on it.
      done.add(result.url);
      if (result.response.status !== 200) continue;
      const xml = result.response.body.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) continue;
      const data = parser.parse(xml);
      const list = (value: unknown): { loc?: unknown }[] => Array.isArray(value) ? value : value ? [value] as { loc?: unknown }[] : [];
      for (const item of list(data.urlset?.url).slice(0, 50_000)) if (typeof item.loc === 'string') add(item.loc, result.url, '', 'sitemap');
      // The request budget is small and a big site's index can list many child sitemaps (blog, events,
      // pages, ...). Children whose own address matches a category the caller declared relevant
      // (`linkPriorityExtraTiers`) are fetched first, so the one that lists the real detail pages is not
      // the one that runs out of budget. Nothing is dropped and the rest keeps its order.
      const children = list(data.sitemapindex?.sitemap).slice(0, 10).map(item => item.loc).filter((loc): loc is string => typeof loc === 'string');
      const relevant = (loc: string) => { try { const path = decodeURI(new URL(loc).pathname).toLowerCase(); return linkPriorityExtraTiers.some(tier => tier.pattern.test(path)); } catch { return false; } };
      pending.unshift(...children.filter(relevant));
      pending.push(...children.filter(loc => !relevant(loc)));
    }
  }

  async function crawlPage(candidate: CrawlCandidate): Promise<CrawlAttempt> {
    const url = candidate.url;
    const context: FetchContext = { candidate, httpStatus: null, transient: false };
    visited.add(url);
    const result = await get(url, 'page', context);
    if (url === scope.homepage) {
      homepageStatus = context.httpStatus;
      homepageBlocked = !result && records.some(item => item.kind === 'page' && !item.attempted && /robots/.test(item.error ?? ''));
    }
    let fetched = false;
    if (result && result.response.status >= 200 && result.response.status < 300) {
      const contentType = result.response.headers['content-type'] ?? '';
      if (/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        fetched = true;
        const $ = loadBuffer(result.response.body);
        const base = $('base[href]').first().attr('href');
        let baseUrl = result.url;
        try { if (base) baseUrl = new URL(base, result.url).href; } catch { /* Use document URL for malformed base. */ }
        const anchors = $('a[href]').toArray().slice(0, 2000);
        const details = anchors.filter(anchor => {
          const url = scope.normalize($(anchor).attr('href')!, baseUrl);
          return url && options.rankCandidate?.({ url, label: $(anchor).text(), source: 'link', discoveredFrom: result.url }).classification === 'detail';
        }).length;
        const source = details >= 3 ? 'listing' : 'link';
        for (const anchor of anchors) add($(anchor).attr('href')!, baseUrl, $(anchor).text(), source);
        const isHomepage = result.url === scope.homepage;
        const priority = linkPriority(result.url, '', linkPriorityExtraTiers);
        const contacts = extractContacts($, scope.domain, options.contactNormalizers);
        contactPages.push({ url: result.url, contacts });
        const extracted = options.extract({ $, url: result.url, isHomepage, priority, contacts });
        if (extracted !== undefined) {
          for (const data of Array.isArray(extracted) ? extracted : [extracted]) extractedPages.push({ url: result.url, data, isHomepage });
        }
      } else errors.push(`Geen HTML-pagina: ${result.url}`);
    }
    return { fetched, httpStatus: context.httpStatus, transient: !result && context.transient };
  }

  return {
    scope,
    limits: { maxPages, maxCandidates, maxDurationMs },
    /** The caller's own requested URL (its own path, not just the site's origin) is always
     * fetched first — see websiteScope's own doc comment on `requestedPage`. A direct deep link
     * (e.g. one specific detail page) must never be silently discarded down to a homepage-only
     * crawl before extraction ever gets a chance to run on it. The site's real homepage is still
     * queued as a normal candidate (unless it *is* the requested page) so it stays available as a
     * rich source of further navigation links, exactly as before. Returns the requested page. */
    seed(): CrawlCandidate {
      add(scope.requestedPage, scope.requestedPage, '', 'requested');
      const requested = candidates.take(visited)!;
      if (scope.requestedPage !== scope.homepage) add(scope.homepage, scope.homepage, '', 'homepage');
      return requested;
    },
    /** The best not-yet-taken candidate, by the caller's own ranking. */
    take: (): CrawlCandidate | undefined => candidates.take(visited),
    /** Marks a URL as claimed by an engine, so a link found later can never queue it a second time. */
    claim(url: string) { visited.add(url); },
    crawlPage,
    markProcessed() { candidatesProcessed++; },
    /** False once the caller's `shouldContinue` says the target is reached. */
    keepGoing(): boolean {
      if (options.shouldContinue && !options.shouldContinue(extractedPages)) { stopReasonCode = 'target_reached'; return false; }
      return true;
    },
    async discoverSitemap(fromUrl: string) {
      if (checkedSitemap || stopped || pages >= maxPages) return;
      checkedSitemap = true;
      await sitemap(fromUrl);
    },
    get halted(): boolean { return stopped !== null; },
    get pagesStarted(): number { return pages; },
    get targetReached(): boolean { return stopReasonCode === 'target_reached'; },
    remainingCandidates: () => candidates.remaining(visited),
    fail(error: unknown) {
      stopped = error instanceof Error ? error.message : String(error);
      errors.push(stopped);
    },
    finish(info: SessionFinishInfo): CrawlResult<TFacts> {
      const successful = records.some(item => item.kind === 'page' && item.status === 'ok' &&
        (item.httpStatus ?? 0) >= 200 && (item.httpStatus ?? 0) < 300 && /html/i.test(item.contentType ?? ''));
      if (stopped) errors.push(stopped);
      // Priority order matches actual loop-break causality: a fully robots-blocked homepage always
      // wins (see `status` below, which already treats it the same way); an explicit event captured
      // live while it happened (target reached, the crawl's own time limit, a 429/503 rate-limit)
      // comes next; then the two numeric caps, page budget before candidate-queue budget (a page-limit
      // stop is certain — we know pages >= maxPages — while candidateLimitReached only means *some*
      // link had to be dropped at some point, not necessarily what ended the loop); anything else is
      // simply "ran out of candidates to try", the natural-completion case.
      const stopReason: CrawlStopReason = homepageBlocked ? 'robots_blocked'
        : stopReasonCode ?? (pages >= maxPages ? 'page_limit' : candidateLimitReached ? 'candidate_limit' : 'no_more_candidates');
      const evidence = [...candidateEvidence.values()];
      // Distinct things to crawl: URLs the domain says are one record (same identity key) count once.
      const uniqueCrawlIdentities = new Set(evidence.map(candidate => identities.get(candidate.canonicalUrl) ?? candidate.canonicalUrl)).size;
      const knownCandidates = evidence.filter(candidate => options.knownCandidates?.has(candidate.canonicalUrl)).length;
      const attempted = records.filter(item => item.attempted);
      const crawlerStats: CrawlerRunStats = {
        crawlerEngine: info.engine,
        requestsQueued: discoveredUrls.size,
        requestsStarted: attempted.length,
        requestsSucceeded: attempted.filter(item => item.status === 'ok' || item.status === 'redirect').length,
        requestsFailed: attempted.filter(item => item.status === 'failed' || item.status === 'http_error').length,
        requestsRetried: info.requestsRetried,
        maxConcurrencyUsed: info.maxConcurrencyUsed,
        queueRemaining: candidates.remaining(visited) + (info.extraQueueRemaining ?? 0),
        durationMs: clock.now() - start,
      };
      return { homepage: scope.homepage, domain: scope.domain, pagesVisited: pages, httpStatus: homepageStatus,
        candidates: evidence,
        discoveryStats: {
          urlsDiscovered, uniqueUrlsDiscovered: discoveredUrls.size, uniqueCrawlIdentities, candidateIdentityDuplicates: evidence.length - uniqueCrawlIdentities,
          sitemapUrlsFound, listingUrlsFound,
          sitemapCandidatesAccepted, sitemapCandidatesRejected, candidateUrlsFound: evidence.length,
          highConfidenceCandidates: evidence.filter(candidate => candidate.candidateScore >= 60).length,
          mediumConfidenceCandidates: evidence.filter(candidate => candidate.candidateScore >= 20 && candidate.candidateScore < 60).length,
          lowConfidenceCandidates: evidence.filter(candidate => candidate.candidateScore < 20).length,
          candidatesProcessed, candidatesRemaining: candidates.remaining(visited) + (info.extraQueueRemaining ?? 0), knownCandidates,
          newCandidates: evidence.length - knownCandidates, unchangedCandidates: unchanged.size,
        },
        status: homepageBlocked ? 'blocked' : !successful ? 'failed' : errors.length ? 'partial' : 'succeeded',
        error: errors.length ? [...new Set(errors)].join('; ').slice(0, 4000) : null, records,
        contacts: mergeContacts(contactPages), extractedPages, stopReason,
        candidatesDiscovered: discoveredUrls.size, candidateLimitReached, crawlerStats };
    },
  };
}

/**
 * The original, serial crawl: one page at a time, always the best remaining candidate. This is the
 * `legacy` engine (see legacy-http-crawler.ts); its behaviour is unchanged.
 */
export async function crawlWebsite<TFacts>(website: string, options: CrawlOptions<TFacts>): Promise<CrawlResult<TFacts>> {
  const session = createCrawlSession(website, options);
  try {
    let next: CrawlCandidate | undefined = session.seed();
    while (next && !session.halted && session.pagesStarted < session.limits.maxPages) {
      await session.crawlPage(next);
      session.markProcessed();
      if (!session.keepGoing()) break;
      await session.discoverSitemap(next.url);
      if (session.pagesStarted >= session.limits.maxPages || session.halted) break;
      next = session.take();
    }
  } catch (error) {
    session.fail(error);
  }
  return session.finish({ engine: 'legacy', maxConcurrencyUsed: 1, requestsRetried: 0 });
}
