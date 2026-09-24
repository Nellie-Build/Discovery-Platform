import {
  SourceError, createRobotsPolicy, normalizeCandidateUrls, stripUrlQueries,
  type DiscoveryCrawler, type DiscoverySource, type ExtractedPage, type HttpTransport, type SourceItem, type SourceSearchProvider,
} from '@discovery-platform/core';
import { parsePrefixes } from './publication-range.js';
import type { CpvCode, SourceRole } from './tender-facts.js';
import { hostRole, type RoleAssessment } from './source-role.js';
import { assessTenderPageMulti, SEARCH_SOURCE_ID, tenderPageIdentity, tenderPageItemIdentity, WEBSITE_SOURCE_ID, type TenderPageAssessment, type TenderPageRaw } from './tender-page.js';
import { rankTenderCandidate, TENDER_LINK_TIER } from './tender-rank.js';
import { buildTenderSearchQueries, countTermHits, parseTenderSearchFilters, resolveCountry, searchTerms, type TenderSearchInput } from './tender-search.js';

/**
 * Two DiscoverySources for tenders that are not on an API: an organisation's own website (`website`) and a web search
 * (`search`). Both use the platform's one crawl engine (the injected DiscoveryCrawler: Crawlee by default) and the
 * one search provider; this file only supplies the tender-specific parts (which links to follow, what a tender page is).
 * A page that is not one concrete tender never becomes an item; it is counted, with its reason, in the run statistics.
 */
const NO_CONTACTS = { normalizePhone: () => null, normalizeEmail: () => null };
/** Sources whose tenders arrive through their own API source; finding them again as web pages would only make noise. */
const API_COVERED_HOST = /(?:^|\.)(?:tenderned\.nl|ted\.europa\.eu)$/i;

export interface WebSourceDeps {
  crawler: DiscoveryCrawler;
  searchProvider?: SourceSearchProvider;
  /** Test seams: the transport and clock every fetch of the crawler uses. */
  transport?: HttpTransport;
  clock?: { now(): number; sleep(ms: number): Promise<unknown> };
}

export interface WebSourceStats {
  pagesVisited: number;
  candidatesDiscovered: number;
  pagesAssessed: number;
  concreteTenders: number;
  overviewPages: number;
  generalInformationPages: number;
  rejectedPages: number;
  rejectionReasons: Record<string, number>;
  filteredByCpv: number;
  cpvUnknown: number;
  duplicateUrlsSkipped: number;
  /** Pages a search step did not fetch because robots.txt forbids it. */
  robotsBlocked: number;
  /** Pages recognised as inline-listing several procurements (no separate links) and split into that many item assessments (see tender-page.ts). */
  multiItemPages: number;
  /** Hosts seen in the run per source role (a host counts once). */
  sourceRoles: Record<SourceRole, number>;
  hostRoles: Record<string, RoleAssessment>;
  crawlStatus?: string;
  crawlerEngine?: string;
  pageDiagnostics: Array<{ url: string; kind: string; rejection: string | null; signals: string[]; tenderLinks: number }>;
  [extra: string]: unknown;
}
export type TenderWebSource = DiscoverySource<TenderPageRaw> & { stats(): WebSourceStats };

const emptyStats = (): WebSourceStats => ({
  pagesVisited: 0, candidatesDiscovered: 0, pagesAssessed: 0, concreteTenders: 0, overviewPages: 0, generalInformationPages: 0, rejectedPages: 0,
  rejectionReasons: {}, filteredByCpv: 0, cpvUnknown: 0, duplicateUrlsSkipped: 0, robotsBlocked: 0, multiItemPages: 0,
  sourceRoles: { official_organization_site: 0, aggregator: 0, unknown_web_source: 0 }, hostRoles: {}, pageDiagnostics: [],
});

/** What every assessed page said about its host's role; kept off the persisted statistics (a symbol key is not serialised). */
const VOTES = Symbol('hostRoleVotes');
function voteFor(stats: WebSourceStats, assessment: TenderPageAssessment) {
  const votes = ((stats as unknown as Record<symbol, Map<string, RoleAssessment[]>>)[VOTES] ??= new Map());
  let host = '';
  try { host = new URL(assessment.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return; }
  votes.set(host, [...(votes.get(host) ?? []), assessment.role]);
}

/**
 * Settles every host's role from all its pages of this run and the contracting authorities of its accepted tenders, records the
 * counts in the statistics and stamps the role on each accepted tender's provenance.
 */
function finalizeRoles(stats: WebSourceStats, items: SourceItem<TenderPageRaw>[]) {
  const votes = ((stats as unknown as Record<symbol, Map<string, RoleAssessment[]>>)[VOTES] ??= new Map());
  const authorities = new Map<string, string[]>();
  for (const item of items) {
    const name = item.raw.assessment.facts?.contractingAuthority;
    if (name) authorities.set(item.raw.discovery.host, [...(authorities.get(item.raw.discovery.host) ?? []), name]);
  }
  stats.sourceRoles = { official_organization_site: 0, aggregator: 0, unknown_web_source: 0 };
  stats.hostRoles = {};
  for (const [host, roles] of votes) {
    const role = hostRole(roles, authorities.get(host) ?? []);
    stats.hostRoles[host] = role;
    stats.sourceRoles[role.role]++;
  }
  for (const item of items) {
    const role = stats.hostRoles[item.raw.discovery.host];
    if (role) Object.assign(item.raw.discovery, { sourceRole: role.role, roleConfidence: role.confidence, roleEvidence: role.evidence });
  }
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

/** A page counts as visited once per run, however its address is written (fragment, tracking parameters, trailing slash). */
function visitKey(url: string): string | null {
  try { const parsed = new URL(url); return `${parsed.protocol}//${tenderPageIdentity(url)}`; } catch { return null; }
}

/** Records one assessment in the statistics; returns whether it is a concrete tender that passes the CPV filter. */
function tally(stats: WebSourceStats, assessment: TenderPageAssessment, cpvPrefixes: string[]): boolean {
  stats.pagesAssessed++;
  voteFor(stats, assessment);
  if (stats.pageDiagnostics.length < 80) stats.pageDiagnostics.push({ url: stripUrlQueries(assessment.url), kind: assessment.kind, rejection: assessment.rejection, signals: assessment.signals, tenderLinks: assessment.tenderLinks });
  if (assessment.kind !== 'detail') {
    if (assessment.kind === 'overview') stats.overviewPages++;
    else if (assessment.kind === 'general') stats.generalInformationPages++;
    stats.rejectedPages++;
    if (assessment.rejection) stats.rejectionReasons[assessment.rejection] = (stats.rejectionReasons[assessment.rejection] ?? 0) + 1;
    return false;
  }
  const codes: CpvCode[] = assessment.facts?.cpvCodes ?? [];
  if (cpvPrefixes.length > 0 && codes.length > 0 && !codes.some(code => cpvPrefixes.some(prefix => code.code.startsWith(prefix)))) {
    stats.filteredByCpv++;
    stats.rejectedPages++;
    stats.rejectionReasons.cpv_mismatch = (stats.rejectionReasons.cpv_mismatch ?? 0) + 1;
    return false;
  }
  if (cpvPrefixes.length > 0 && codes.length === 0) stats.cpvUnknown++;
  stats.concreteTenders++;
  return true;
}

interface CrawlSettings { maxPages: number; maxCandidates: number; maxDurationMs: number; cpvPrefixes: string[]; target: number }

/** One crawl of a website through the platform's crawl engine, ranked and extracted the tender way. */
async function crawlSite(
  deps: WebSourceDeps, url: string, settings: CrawlSettings, context: { via: TenderPageRaw['discovery']['via']; query: string | null; searchProvider: string | null },
  visited: Set<string>, stats: WebSourceStats, fetchedUrls: Iterable<string> = [],
): Promise<SourceItem<TenderPageRaw>[]> {
  const items: SourceItem<TenderPageRaw>[] = [];
  const accepted = new Set<string>();
  const assessedBefore = stats.pagesAssessed;
  const crawl = await deps.crawler.crawl<TenderPageAssessment>(url, {
    rankCandidate: rankTenderCandidate,
    linkPriorityExtraTiers: [TENDER_LINK_TIER],
    contactNormalizers: NO_CONTACTS,
    transport: deps.transport,
    clock: deps.clock,
    maxPages: settings.maxPages,
    maxCandidates: settings.maxCandidates,
    maxDurationMs: settings.maxDurationMs,
    // Pages an earlier step of this run already fetched are not requested again.
    skipUrls: [...fetchedUrls],
    extract: page => {
      const key = visitKey(page.url);
      if (key && visited.has(key)) { stats.duplicateUrlsSkipped++; return undefined; }
      if (key) visited.add(key);
      // A page that inline-lists several procurements (no separate links to follow) comes back as one assessment per
      // procurement; an ordinary page is still just the one assessment it always was.
      const result = assessTenderPageMulti(page);
      const list = Array.isArray(result) ? result : [result];
      if (Array.isArray(result)) stats.multiItemPages++;
      const acceptedItems = list.filter(item => tally(stats, item, settings.cpvPrefixes));
      if (acceptedItems.length > 0) accepted.add(page.url);
      return acceptedItems.length > 0 ? acceptedItems : undefined;
    },
    shouldContinue: () => accepted.size < settings.target,
  });
  stats.pagesVisited += crawl.pagesVisited;
  stats.candidatesDiscovered += crawl.candidatesDiscovered;
  stats.crawlStatus = crawl.status;
  stats.crawlerEngine = crawl.crawlerStats?.crawlerEngine;
  stats.stopReason = crawl.stopReason;
  if ((crawl.status === 'failed' || crawl.status === 'blocked') && stats.pagesAssessed === assessedBefore) {
    throw new SourceError(`De website kon niet worden gecrawld (${crawl.status}): ${crawl.error ? stripUrlQueries(crawl.error).slice(0, 300) : 'geen pagina opgehaald'}.`, 'http');
  }
  const fetchedAt = new Date().toISOString();
  for (const page of crawl.extractedPages as ExtractedPage<TenderPageAssessment>[]) {
    if (!accepted.has(page.url)) continue;
    const from = crawl.candidates.find(candidate => candidate.canonicalUrl === page.url)?.discoveredFrom ?? null;
    items.push(rawItem(page.data, fetchedAt, { ...context, discoveredFrom: from && from !== page.url ? from : null }));
  }
  return items;
}

function rawItem(assessment: TenderPageAssessment, fetchedAt: string, context: { via: TenderPageRaw['discovery']['via']; query: string | null; searchProvider: string | null; discoveredFrom: string | null }): SourceItem<TenderPageRaw> {
  // A procurement split out of a page that inline-lists several (see tender-page.ts) needs its own section-scoped
  // identity: several such items share the same page URL, so the plain page identity alone would collide.
  const identity = assessment.sectionId !== undefined ? tenderPageItemIdentity(assessment.url, assessment.sectionId) : tenderPageIdentity(assessment.url);
  return {
    externalId: identity, sourceUrl: assessment.url, fetchedAt,
    raw: {
      url: assessment.url, assessment,
      discovery: {
        via: context.via, host: new URL(assessment.url).hostname.toLowerCase().replace(/^www\./, ''), query: context.query, searchProvider: context.searchProvider,
        discoveredFrom: context.discoveredFrom, evidence: assessment.signals, publisher: assessment.publisher, authoritySource: assessment.authoritySource,
        // Where possible, a pointer to the specific procurement within the page (see tender-page.ts's splitTenderPageSections); absent for an ordinary one-tender page.
        pageSection: assessment.sectionHeading ?? null,
      },
    },
  };
}

// ─── WebsiteCrawlerSource ────────────────────────────────────────────────────────────────────────────────────────────

export interface WebsiteFilters { url: string; maxPages: number; maxCandidates: number; maxDurationMs: number; cpvPrefixes: string[]; target: number }

export function parseWebsiteFilters(input: Record<string, unknown>): WebsiteFilters {
  if (typeof input.url !== 'string' || !input.url.trim()) throw new SourceError('Geef de URL van een website op.', 'invalid_filters');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input.url.trim()) ? input.url.trim() : `https://${input.url.trim()}`); } catch { throw new SourceError('De website-URL is ongeldig.', 'invalid_filters'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SourceError('Alleen publieke http(s)-URLs worden ondersteund.', 'invalid_filters');
  return {
    url: url.href, maxPages: clampInt(input.maxPages, 10, 1, 60), maxCandidates: clampInt(input.maxCandidates, 200, 1, 500),
    maxDurationMs: clampInt(input.maxDurationMs, 120_000, 5_000, 300_000), cpvPrefixes: parsePrefixes(input.cpvPrefixes, 'cpvPrefixes', /^\d{2,8}$/),
    target: clampInt(input.targetRecords, 20, 1, 200),
  };
}

/** Crawls one organisation website (the URL may be its homepage, a tender overview or one tender page) for concrete tenders. */
export function createWebsiteCrawlerSource(deps: WebSourceDeps): TenderWebSource {
  const stats = emptyStats();
  return {
    id: WEBSITE_SOURCE_ID, kind: 'website',
    stats: () => stats,
    async fetchBatch({ cursor, filters, limit }) {
      const f = parseWebsiteFilters(filters);
      if (cursor !== null) return { items: [], nextCursor: null, exhausted: true };
      const items = await crawlSite(deps, f.url, { ...f, target: Math.min(f.target, Math.max(1, limit)) }, { via: 'website_crawl', query: null, searchProvider: null }, new Set(), stats);
      finalizeRoles(stats, items);
      return { items, nextCursor: null, exhausted: true };
    },
  };
}

// ─── SearchProviderSource ────────────────────────────────────────────────────────────────────────────────────────────

export interface SearchSourceFilters extends TenderSearchInput { maxQueries: number; maxCandidates: number; maxOverviewCrawls: number; overviewPages: number; maxDurationMs: number; target: number }

export function parseSearchSourceFilters(input: Record<string, unknown>): SearchSourceFilters {
  return {
    ...parseTenderSearchFilters(input),
    maxQueries: clampInt(input.maxQueries, 4, 1, 8), maxCandidates: clampInt(input.maxCandidates, 30, 1, 100),
    maxOverviewCrawls: clampInt(input.maxOverviewCrawls, 2, 0, 5), overviewPages: clampInt(input.overviewPages, 6, 1, 20),
    maxDurationMs: clampInt(input.maxDurationMs, 120_000, 5_000, 300_000), target: clampInt(input.targetRecords, 20, 1, 200),
  };
}

/**
 * Finds tenders without knowing a website: the search input becomes several web searches (tender intents x branch x
 * keywords x region), the results are fetched best-guess first, and each page is judged by assessTenderPage. A result
 * that is an overview or a general purchasing page is a lead: the site behind it is crawled once (small budget) for
 * the concrete tenders it links to. A page is fetched at most once per run, and a site is crawled at most once.
 */
export function createSearchProviderSource(deps: WebSourceDeps): TenderWebSource {
  const stats = emptyStats();
  // Which provider answered is per-result (discovery.searchProvider, from the result's own `source`), never a single
  // value here: a run may mix providers if the configuration changes mid-run, and this file never names one itself.
  Object.assign(stats, { queries: [] as unknown[], searchCandidates: 0, candidatesFetched: 0, apiCoveredSkipped: 0, overviewCrawls: 0, queryErrors: 0 });
  return {
    id: SEARCH_SOURCE_ID, kind: 'api',
    stats: () => stats,
    async fetchBatch({ cursor, filters, limit }) {
      const f = parseSearchSourceFilters(filters);
      if (cursor !== null) return { items: [], nextCursor: null, exhausted: true };
      if (!deps.searchProvider) throw new SourceError('Web-zoeken is niet beschikbaar: er is geen zoekprovider geconfigureerd.', 'invalid_filters');
      const country = resolveCountry(f.country);
      const started = Date.now();
      // The single fetches of search results follow robots.txt like the crawl does (one robots.txt request per origin).
      const robots = createRobotsPolicy({ transport: deps.transport });
      const timeUp = () => Date.now() - started >= f.maxDurationMs;
      const target = Math.min(f.target, Math.max(1, limit));

      // 1. Search: every planned query, each result kept with the query that found it.
      const planned = buildTenderSearchQueries(f, { maxQueries: f.maxQueries });
      const perQuery = Math.min(20, Math.max(5, Math.ceil(f.maxCandidates / Math.max(1, planned.length)) + 3));
      const found: Array<{ url: string; title: string | null; snippet: string | null; source: string; query: string }> = [];
      let lastError: unknown = null;
      for (const { query, intent } of planned) {
        if (timeUp()) break;
        try {
          const results = await deps.searchProvider.search({ query, country: country.code, language: country.language, count: perQuery });
          (stats.queries as unknown[]).push({ query, intent, results: results.length });
          for (const result of results) found.push({ ...result, query });
        } catch (error) {
          lastError = error;
          stats.queryErrors = (stats.queryErrors as number) + 1;
          (stats.queries as unknown[]).push({ query, intent, results: 0, error: error instanceof Error ? error.message.slice(0, 200) : 'zoekopdracht mislukt' });
        }
      }
      if (found.length === 0 && lastError) throw new SourceError(`De zoekprovider gaf geen resultaten: ${lastError instanceof Error ? lastError.message.slice(0, 200) : 'onbekende fout'}`, 'http');

      // 2. Candidates: clean URLs, drop the API-covered hosts, rank the rest (tender-looking paths and text, the user's terms).
      // Cleaned one by one so each result keeps the query that found it.
      const seenUrls = new Set<string>();
      const cleaned: Array<(typeof found)[number]> = [];
      for (const entry of found) {
        const [clean] = normalizeCandidateUrls([entry], { maxCandidates: 1 });
        if (!clean || seenUrls.has(clean.url.toLowerCase()) || cleaned.length >= 200) continue;
        seenUrls.add(clean.url.toLowerCase());
        cleaned.push({ ...entry, ...clean });
      }
      const queryOf = new Map(cleaned.map(entry => [entry.url, entry.query]));
      const providerOf = new Map(cleaned.map(entry => [entry.url, entry.source]));
      const terms = searchTerms(f.branch, f.keywords, f.region);
      const candidates = cleaned.filter(candidate => {
        if (API_COVERED_HOST.test(new URL(candidate.url).hostname)) { stats.apiCoveredSkipped = (stats.apiCoveredSkipped as number) + 1; return false; }
        return true;
      }).map(candidate => {
        const rank = rankTenderCandidate({ url: candidate.url, source: 'link', label: `${candidate.title ?? ''} ${candidate.snippet ?? ''}`, discoveredFrom: candidate.url });
        return { candidate, classification: rank.classification, priority: rank.score + 6 * countTermHits(`${candidate.title ?? ''} ${candidate.snippet ?? ''} ${decodeURI(new URL(candidate.url).pathname)}`, terms) };
      }).filter(entry => entry.classification !== 'pagination').sort((a, b) => b.priority - a.priority);
      stats.searchCandidates = candidates.length;

      // 3. Fetch each candidate once; keep concrete tenders, remember overviews as leads.
      const visited = new Set<string>();
      const fetchedUrls = new Set<string>();
      const items: SourceItem<TenderPageRaw>[] = [];
      const leads: string[] = [];
      const fetchedAt = new Date().toISOString();
      for (const { candidate, classification } of candidates) {
        if (items.length >= target || (stats.candidatesFetched as number) >= f.maxCandidates || timeUp()) break;
        const key = visitKey(candidate.url);
        if (key && visited.has(key)) { stats.duplicateUrlsSkipped++; continue; }
        // A URL that already reads as a tender overview is not fetched here: it is the starting point of a crawl below, which fetches it once.
        if (classification === 'listing') { leads.push(candidate.url); stats.leadsFromUrl = ((stats.leadsFromUrl as number | undefined) ?? 0) + 1; continue; }
        if (key) visited.add(key);
        stats.candidatesFetched = (stats.candidatesFetched as number) + 1;
        fetchedUrls.add(candidate.url);
        const result = await deps.crawler.fetchPage<TenderPageAssessment>(candidate.url, {
          extract: page => assessTenderPageMulti(page), contactNormalizers: NO_CONTACTS, transport: deps.transport, robots,
        });
        if (result.blockedBy === 'robots') {
          stats.robotsBlocked++;
          stats.rejectedPages++;
          stats.rejectionReasons.robots_blocked = (stats.rejectionReasons.robots_blocked ?? 0) + 1;
          if (stats.pageDiagnostics.length < 80) stats.pageDiagnostics.push({ url: stripUrlQueries(candidate.url), kind: 'none', rejection: 'robots_blocked', signals: [], tenderLinks: 0 });
          continue;
        }
        stats.pagesVisited++;
        const results = result.data ?? [];
        if (results.length === 0) {
          stats.rejectedPages++;
          stats.rejectionReasons.fetch_failed = (stats.rejectionReasons.fetch_failed ?? 0) + 1;
          if (stats.pageDiagnostics.length < 80) stats.pageDiagnostics.push({ url: stripUrlQueries(candidate.url), kind: 'none', rejection: 'fetch_failed', signals: [], tenderLinks: 0 });
          continue;
        }
        // A page split into several inline procurements (see assessTenderPageMulti) always arrives as several 'detail'
        // assessments; an ordinary page is still just the one, of whatever kind it turned out to be.
        if (results.length > 1) stats.multiItemPages++;
        for (const assessment of results) {
          if (tally(stats, assessment, f.cpvPrefixes)) {
            items.push(rawItem(assessment, fetchedAt, { via: 'web_search', query: queryOf.get(candidate.url) ?? null, searchProvider: candidate.source, discoveredFrom: null }));
          } else if (assessment.kind === 'overview' || assessment.kind === 'general') {
            leads.push(candidate.url);
          }
        }
      }

      // 4. Leads: crawl the site behind an overview / purchasing-information page once, briefly.
      const crawledOrigins = new Set<string>();
      for (const lead of leads) {
        if (items.length >= target || (stats.overviewCrawls as number) >= f.maxOverviewCrawls || timeUp()) break;
        const origin = new URL(lead).hostname.toLowerCase().replace(/^www./, '');
        if (crawledOrigins.has(origin)) continue;
        crawledOrigins.add(origin);
        stats.overviewCrawls = (stats.overviewCrawls as number) + 1;
        try {
          const found = await crawlSite(deps, lead, { maxPages: f.overviewPages, maxCandidates: 100, maxDurationMs: Math.max(5_000, f.maxDurationMs - (Date.now() - started)), cpvPrefixes: f.cpvPrefixes, target: target - items.length },
            { via: 'web_search', query: queryOf.get(lead) ?? null, searchProvider: providerOf.get(lead) ?? null }, visited, stats, fetchedUrls);
          items.push(...found.filter(item => !items.some(existing => existing.externalId === item.externalId)));
        } catch { /* one unreachable site never fails the whole search */ stats.rejectionReasons.overview_crawl_failed = (stats.rejectionReasons.overview_crawl_failed ?? 0) + 1; }
      }
      const accepted = items.slice(0, target);
      finalizeRoles(stats, accepted);
      return { items: accepted, nextCursor: null, exhausted: true };
    },
  };
}
