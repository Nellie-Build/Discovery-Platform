import {
  SourceError, createRobotsPolicy, normalizeCandidateUrls, stripUrlQueries,
  type DiscoveryCrawler, type DiscoverySource, type HttpTransport, type SourceItem, type SourceSearchProvider,
} from '@discovery-platform/core';
import { CriteriaError, hasSubject, interpretDescription, parseCriteria, type CompanySearchCriteria } from './criteria.js';
import { COMPANY_LINK_TIER, CONTACT_NORMALIZERS, analyzeCompanyPage, isNonInformativePage, rankCompanyCandidate, termSpecs, type PageAnalysis, type TermSpec } from './page-analysis.js';
import { companyIdentity, registrableDomain } from './identity.js';
import { buildCompanySearchQueries, excludedHostKind } from './search-plan.js';
import { expandValue } from './vocabulary.js';
import { normalizeText, termPattern } from './text.js';

/**
 * Two DiscoverySources for companies, both on the platform's one crawl engine (Crawlee by default: robots.txt, SSRF-safe
 * transport, page and time limits) and its one search provider (Tavily or Brave):
 *  - `website` (route B): one company site the user names; its informative pages are read.
 *  - `search` (route A): targeted web searches from the criteria; results on directories, review/comparison sites,
 *    social media, job boards and news are never treated as a company (they are counted); each remaining domain is a
 *    candidate company whose own site is then read, a few pages each.
 * A site that cannot be read never fails the run: it is reported, and the run is marked partial by the adapter.
 */
export const COMPANY_WEBSITE_SOURCE_ID = 'website';
export const COMPANY_SEARCH_SOURCE_ID = 'search';

export interface CompanyWebDeps {
  crawler: DiscoveryCrawler;
  searchProvider?: SourceSearchProvider;
  transport?: HttpTransport;
  clock?: { now(): number; sleep(ms: number): Promise<unknown> };
}

export interface CompanyRaw {
  website: string;
  pages: PageAnalysis[];
  via: 'website' | 'web_search';
  query: string | null;
  searchProvider: string | null;
  searchSnippet: string | null;
  /** Whether the site's crawl stopped early (time or page limit) or some pages could not be fetched. */
  incomplete: boolean;
}

export interface CompanySourceStats {
  queries: Array<{ query: string; angle: string; results: number; error?: string }>;
  searchResults: number;
  excludedResults: Record<string, number>;
  companyCandidates: number;
  companiesResearched: number;
  candidatesNotResearched: number;
  pagesVisited: number;
  robotsBlocked: number;
  sitesFailed: Array<{ domain: string; reason: string }>;
  sitesIncomplete: string[];
  timeLimitReached: boolean;
  [extra: string]: unknown;
}

const emptyStats = (): CompanySourceStats => ({
  queries: [], searchResults: 0, excludedResults: {}, companyCandidates: 0, companiesResearched: 0, candidatesNotResearched: 0,
  pagesVisited: 0, robotsBlocked: 0, sitesFailed: [], sitesIncomplete: [], timeLimitReached: false,
});

export type CompanySource = DiscoverySource<CompanyRaw> & { stats(): CompanySourceStats };

const clampInt = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;

/** The criteria of a request: validated structured criteria, or (when none are given) the interpreted description. */
export function criteriaFrom(filters: Record<string, unknown>): CompanySearchCriteria {
  let criteria: CompanySearchCriteria;
  try { criteria = parseCriteria(filters); } catch (error) { throw new SourceError(error instanceof CriteriaError ? error.message : 'Ongeldige zoekcriteria.', 'invalid_filters'); }
  if (!hasSubject(criteria) && criteria.description) {
    const interpreted = interpretDescription(criteria.description).criteria;
    criteria = { ...interpreted, provinces: criteria.provinces.length ? criteria.provinces : interpreted.provinces, places: criteria.places.length ? criteria.places : interpreted.places, exclusions: [...criteria.exclusions, ...interpreted.exclusions] };
  }
  return criteria;
}

export function parseWebsiteUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new SourceError('Geef de website van een bedrijf op.', 'invalid_filters');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); } catch { throw new SourceError('De website-URL is ongeldig.', 'invalid_filters'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SourceError('Alleen publieke http(s)-websites worden ondersteund.', 'invalid_filters');
  const kind = excludedHostKind(url.hostname);
  if (kind) throw new SourceError(`Dit is geen bedrijfswebsite maar een ${kind === 'social' ? 'sociaal netwerk' : kind === 'directory' ? 'bedrijvengids' : 'andere bron'}; geef de eigen website van het bedrijf op.`, 'invalid_filters');
  return url.href;
}

/** Reads one company's site: the given page (when it is not the homepage) and the site's most informative pages. */
async function researchCompany(
  deps: CompanyWebDeps, startUrl: string, specs: TermSpec[], settings: { pages: number; maxDurationMs: number }, stats: CompanySourceStats,
): Promise<{ pages: PageAnalysis[]; incomplete: boolean }> {
  const { website } = companyIdentity(startUrl);
  const pages: PageAnalysis[] = [];
  let incomplete = false;
  const extra = startUrl.replace(/[#?].*$/, '') !== website && startUrl.replace(/[#?].*$/, '') !== website.replace(/\/$/, '') ? startUrl : null;
  if (extra) {
    const result = await deps.crawler.fetchPage<PageAnalysis>(extra, {
      extract: page => analyzeCompanyPage(page, specs), contactNormalizers: CONTACT_NORMALIZERS, transport: deps.transport, robots: createRobotsPolicy({ transport: deps.transport }),
    });
    if (result.blockedBy === 'robots') { stats.robotsBlocked++; incomplete = true; }
    else if (result.data?.[0]) { pages.push(result.data[0]); stats.pagesVisited++; }
    // A page that does not exist (404) is not a gap in the profile; any other failure is.
    else if (result.httpStatus !== 404) incomplete = true;
  }
  const crawl = await deps.crawler.crawl<PageAnalysis>(website, {
    rankCandidate: rankCompanyCandidate,
    linkPriorityExtraTiers: [COMPANY_LINK_TIER],
    contactNormalizers: CONTACT_NORMALIZERS,
    transport: deps.transport,
    clock: deps.clock,
    maxPages: Math.max(1, settings.pages - pages.length),
    maxCandidates: 60,
    maxDurationMs: settings.maxDurationMs,
    skipUrls: extra ? [extra] : [],
    extract: page => (isNonInformativePage(page.url) ? undefined : analyzeCompanyPage(page, specs)),
  });
  stats.pagesVisited += crawl.pagesVisited;
  if (crawl.stopReason === 'robots_blocked') stats.robotsBlocked++;
  for (const page of crawl.extractedPages) if (!pages.some(existing => existing.url === page.url)) pages.push(page.data);
  if ((crawl.status === 'failed' || crawl.status === 'blocked') && pages.length === 0) {
    throw new SourceError(`${crawl.status === 'blocked' ? 'geblokkeerd (robots.txt of toegang)' : 'niet bereikbaar'}${crawl.error ? `: ${stripUrlQueries(crawl.error).slice(0, 160)}` : ''}`, 'http');
  }
  // Stopping at the page budget is by design (the most informative pages come first); a time limit, rate limit or block is not.
  if (crawl.stopReason === 'time_limit' || crawl.stopReason === 'rate_limited' || crawl.stopReason === 'robots_blocked') incomplete = true;
  return { pages, incomplete };
}

// ─── Route B: one company website ───────────────────────────────────────────────────────────────────────────────────

export function createCompanyWebsiteSource(deps: CompanyWebDeps): CompanySource {
  const stats = emptyStats();
  return {
    id: COMPANY_WEBSITE_SOURCE_ID, kind: 'website',
    stats: () => stats,
    async fetchBatch({ cursor, filters }) {
      if (cursor !== null) return { items: [], nextCursor: null, exhausted: true };
      const url = parseWebsiteUrl(filters.url);
      const criteria = criteriaFrom({ ...filters, url: undefined });
      stats.companyCandidates = 1;
      const { pages, incomplete } = await researchCompany(deps, url, termSpecs(criteria), {
        pages: clampInt(filters.pagesPerCompany, 12, 1, 25), maxDurationMs: clampInt(filters.maxDurationMs, 90_000, 5_000, 300_000),
      }, stats).catch(error => {
        stats.sitesFailed.push({ domain: registrableDomain(new URL(url).hostname), reason: error instanceof Error ? error.message.slice(0, 200) : 'onbekende fout' });
        throw error instanceof SourceError ? error : new SourceError('De website kon niet worden gelezen.', 'http');
      });
      stats.companiesResearched = 1;
      if (incomplete) stats.sitesIncomplete.push(registrableDomain(new URL(url).hostname));
      const item: SourceItem<CompanyRaw> = {
        externalId: registrableDomain(new URL(url).hostname), sourceUrl: url, fetchedAt: new Date().toISOString(),
        raw: { website: url, pages, via: 'website', query: null, searchProvider: null, searchSnippet: null, incomplete },
      };
      return { items: [item], nextCursor: null, exhausted: true };
    },
  };
}

// ─── Route A: search ────────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate { domain: string; url: string; title: string | null; snippet: string | null; query: string; provider: string; results: number; termHits: number }

export function createCompanySearchSource(deps: CompanyWebDeps): CompanySource {
  const stats = emptyStats();
  return {
    id: COMPANY_SEARCH_SOURCE_ID, kind: 'api',
    stats: () => stats,
    async fetchBatch({ cursor, filters, limit }) {
      if (cursor !== null) return { items: [], nextCursor: null, exhausted: true };
      const criteria = criteriaFrom(filters);
      if (!hasSubject(criteria)) throw new SourceError('Geef aan wat voor bedrijven je zoekt: een branche, product, dienst, specialisatie, afnemerssector, rol of zoekterm.', 'invalid_filters');
      if (!deps.searchProvider) throw new SourceError('Zoeken op het web is niet beschikbaar: er is geen zoekprovider geconfigureerd. Analyseer een bedrijfswebsite direct.', 'invalid_filters');
      const maxDurationMs = clampInt(filters.maxDurationMs, 180_000, 10_000, 300_000);
      const maxCompanies = Math.min(clampInt(filters.maxCompanies, 8, 1, 25), Math.max(1, limit));
      const pagesPerCompany = clampInt(filters.pagesPerCompany, 5, 1, 12);
      const started = Date.now();
      const timeLeft = () => maxDurationMs - (Date.now() - started);

      // 1. Search.
      const planned = buildCompanySearchQueries(criteria, clampInt(filters.maxQueries, 4, 1, 8));
      const found: Array<{ url: string; title: string | null; snippet: string | null; source: string; query: string }> = [];
      let lastError: unknown = null;
      for (const { query, angle } of planned) {
        if (timeLeft() <= 0) { stats.timeLimitReached = true; break; }
        try {
          const results = await deps.searchProvider.search({ query, country: criteria.country, language: 'nl', count: 10 });
          stats.queries.push({ query, angle, results: results.length });
          for (const result of results) found.push({ ...result, query });
        } catch (error) {
          lastError = error;
          stats.queries.push({ query, angle, results: 0, error: error instanceof Error ? error.message.slice(0, 200) : 'zoekopdracht mislukt' });
        }
      }
      stats.searchResults = found.length;
      if (found.length === 0 && lastError) throw new SourceError(`De zoekprovider gaf geen resultaten: ${lastError instanceof Error ? lastError.message.slice(0, 200) : 'onbekende fout'}`, 'http');

      // 2. Candidate companies: one per domain, never a directory/social/news/... host.
      const terms = [criteria.query, ...criteria.industries, ...criteria.products, ...criteria.services, ...criteria.specialisations, ...criteria.customerSectors]
        .filter((value): value is string => Boolean(value)).flatMap(value => [...expandValue('product', value), ...expandValue('service', value), ...expandValue('industry', value), ...expandValue('specialisation', value), ...expandValue('customer_sector', value)]);
      const patterns = [...new Set(terms.map(term => normalizeText(term)))].map(term => termPattern(term));
      const byDomain = new Map<string, Candidate>();
      for (const result of found) {
        const [clean] = normalizeCandidateUrls([result], { maxCandidates: 1 });
        if (!clean) continue;
        const host = new URL(clean.url).hostname;
        const excluded = excludedHostKind(host);
        if (excluded) { stats.excludedResults[excluded] = (stats.excludedResults[excluded] ?? 0) + 1; continue; }
        const domain = registrableDomain(host);
        const text = normalizeText(`${result.title ?? ''} ${result.snippet ?? ''}`);
        const hits = patterns.filter(pattern => { pattern.lastIndex = 0; return pattern.test(text); }).length;
        const existing = byDomain.get(domain);
        if (existing) { existing.results++; existing.termHits = Math.max(existing.termHits, hits); continue; }
        byDomain.set(domain, { domain, url: clean.url, title: result.title, snippet: result.snippet, query: result.query, provider: result.source, results: 1, termHits: hits });
      }
      const candidates = [...byDomain.values()].sort((a, b) => b.termHits - a.termHits || b.results - a.results);
      stats.companyCandidates = candidates.length;

      // 3. Read each candidate's own site, best candidates first, within the time budget.
      const specs = termSpecs(criteria);
      const items: SourceItem<CompanyRaw>[] = [];
      for (const candidate of candidates) {
        if (items.length >= maxCompanies) break;
        // The time left is shared by the companies still to research, so the first site cannot use it all.
        const budget = Math.min(45_000, Math.max(8_000, Math.floor(timeLeft() / Math.max(1, maxCompanies - items.length))), timeLeft());
        if (budget < 5_000) { stats.timeLimitReached = true; break; }
        try {
          const { pages, incomplete } = await researchCompany(deps, candidate.url, specs, { pages: pagesPerCompany, maxDurationMs: budget }, stats);
          stats.companiesResearched++;
          if (incomplete) stats.sitesIncomplete.push(candidate.domain);
          items.push({
            externalId: candidate.domain, sourceUrl: candidate.url, fetchedAt: new Date().toISOString(),
            raw: { website: candidate.url, pages, via: 'web_search', query: candidate.query, searchProvider: candidate.provider, searchSnippet: [candidate.title, candidate.snippet].filter(Boolean).join(' — ').slice(0, 400) || null, incomplete },
          });
        } catch (error) {
          stats.sitesFailed.push({ domain: candidate.domain, reason: error instanceof Error ? error.message.slice(0, 200) : 'onbekende fout' });
        }
      }
      stats.candidatesNotResearched = Math.max(0, candidates.length - stats.companiesResearched - stats.sitesFailed.length);
      return { items, nextCursor: null, exhausted: true };
    },
  };
}
