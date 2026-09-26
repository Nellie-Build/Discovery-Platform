/**
 * The companies module's DomainAdapter. One run finds companies by what they do (route A, `search`: web searches from
 * the criteria, then each candidate's own site) or reads one company website (route B, `website`), builds a profile per
 * company with evidence per criterion, and returns new, updated and unchanged companies for the generic run/record
 * persistence in routes/runs.ts. A `{ sourceUrl }` run is route B; a `{ branch, keywords, region }` run is route A.
 * Crawl engine and search provider come from server configuration only, exactly as for the other modules.
 */
import {
  createConfiguredSearchProvider, createDiscoveryCrawler, parseCrawlerEngine, SourceError,
  type DiscoveryCrawler, type HttpTransport, type SourceSearchProvider,
} from '@discovery-platform/core';
import {
  buildCompanyProfile, companyProfileSignals, createCompanySearchSource, createCompanyWebsiteSource, criteriaFrom, evaluateCompany, findPlace, findProvince,
  isPublicAuthority, looksLikeCompanySite, storedCompanyFacts, storedCompanyIdentityKey, summarizeCriteria, updateStoredCompany, withSearch,
  COMPANY_SEARCH_SOURCE_ID, COMPANY_WEBSITE_SOURCE_ID, type CompanyFacts, type CompanySearchCriteria, type CompanySource, type MatchStatus,
} from '@discovery-platform/domain-companies';
import type { DiscoveredRecord, DiscoveryRunInput, DiscoveryRunOutcome, DomainAdapter } from '../domain-registry.js';

export interface CompaniesAdapterOptions {
  /** Test seams: the crawl engine, search provider, transport and clock the sources use instead of the configured ones. */
  web?: { crawler?: DiscoveryCrawler; searchProvider?: SourceSearchProvider; transport?: HttpTransport; clock?: { now(): number; sleep(ms: number): Promise<unknown> } };
}

function configuredCrawler(): DiscoveryCrawler {
  const concurrency = Number.parseInt(process.env.DISCOVERY_CRAWLER_CONCURRENCY ?? '', 10);
  return createDiscoveryCrawler(parseCrawlerEngine(process.env.DISCOVERY_CRAWLER_ENGINE), Number.isFinite(concurrency) ? { maxConcurrency: concurrency } : {});
}
function configuredSearchProvider(): SourceSearchProvider | undefined {
  return createConfiguredSearchProvider({
    provider: process.env.SEARCH_PROVIDER === 'brave' || process.env.SEARCH_PROVIDER === 'tavily' ? process.env.SEARCH_PROVIDER : undefined,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
  });
}

const failure = (error: string, stats: Record<string, unknown>): DiscoveryRunOutcome => ({ status: 'failed', error, records: [], stats });
const describe = (error: unknown) => (error instanceof SourceError ? (error.code === 'invalid_filters' ? error.message : `${error.code}: ${error.message}`) : 'De bron kon niet worden gelezen.');
const STATUS_ORDER: Record<MatchStatus, number> = { confirmed: 0, possible: 1, insufficient: 2 };
const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** A `branch` run (branch/keywords/region) as company criteria: the branch is an industry, the region a province or place. */
function branchFilters(input: Extract<DiscoveryRunInput, { mode: 'branch' }>): Record<string, unknown> {
  const region = input.region?.trim() ?? '';
  const province = region ? findProvince(region) : null;
  const place = region && !province ? findPlace(region) : null;
  return {
    ...input.filters, industries: [input.branch], query: input.keywords ?? undefined, country: input.country ?? input.filters.country,
    provinces: province ? [province.id] : undefined, places: place ? [place.name] : undefined, extra: region && !province && !place ? region : undefined,
  };
}

export function createCompaniesAdapter(options: CompaniesAdapterOptions = {}): DomainAdapter {
  const web = () => ({ crawler: options.web?.crawler ?? configuredCrawler(), searchProvider: options.web?.searchProvider ?? configuredSearchProvider(), transport: options.web?.transport, clock: options.web?.clock });

  const recordFor = (facts: CompanyFacts, existingRecordId?: string): DiscoveredRecord => {
    const signals = companyProfileSignals(facts);
    return {
      ...(existingRecordId ? { existingRecordId } : {}),
      displayName: facts.name ?? facts.domain,
      domainData: facts as unknown as Record<string, unknown>,
      classification: { ...signals, matchStatus: facts.search?.status ?? null },
      // No quality or lead score: the module describes companies and evidence, it does not rate them.
      score: null,
      sources: facts.sources.map(source => ({ sourceType: 'website', sourceUrl: source.url, sourceLabel: 'companies', sourceData: { type: source.type, pageType: source.pageType, title: source.title, checkedAt: source.checkedAt, identity: facts.identity } })),
      contacts: [],
    };
  };

  return {
    id: 'companies',
    async runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunOutcome> {
      const start = Date.now();
      const config = input.runConfig;
      let route: string;
      let filters: Record<string, unknown>;
      if (input.mode === 'source') { route = input.sourceId; filters = input.filters; }
      else if (input.mode === 'website') { route = COMPANY_WEBSITE_SOURCE_ID; filters = { ...input.filters, url: input.sourceUrl }; }
      else { route = COMPANY_SEARCH_SOURCE_ID; filters = branchFilters(input); }
      const baseStats: Record<string, unknown> = { searchMode: input.mode, sourceId: route, targetRecords: config.targetRecords, maxDurationMs: config.maxDurationMs };
      if (route !== COMPANY_SEARCH_SOURCE_ID && route !== COMPANY_WEBSITE_SOURCE_ID) return failure(`Onbekende bron "${route}". Kies zoeken of een bedrijfswebsite.`, baseStats);
      // A follow-up batch continues a search with the candidates it left (see routes/runs.ts); a website analysis has none.
      const cursor = input.continuation?.cursor ?? null;
      if (cursor !== null && route !== COMPANY_SEARCH_SOURCE_ID) return failure('Alleen een zoekopdracht kan in batches worden voortgezet.', baseStats);

      let criteria: CompanySearchCriteria;
      try { criteria = criteriaFrom({ ...filters, url: undefined }); } catch (error) { return failure(describe(error), baseStats); }
      // `companyCriteria`, not `criteria`: the run route stores its own `criteria` (the request) under that key.
      Object.assign(baseStats, { companyCriteria: criteria, criteriaSummary: summarizeCriteria(criteria) });

      // Budgets: companies per run, pages per company, one time limit for the whole run.
      const maxCompanies = Math.max(1, Math.min(num(filters.maxCompanies, 8), config.targetRecords, 25));
      const source: CompanySource = route === COMPANY_SEARCH_SOURCE_ID ? createCompanySearchSource(web()) : createCompanyWebsiteSource(web());
      const sourceFilters = {
        ...filters, maxDurationMs: config.maxDurationMs, maxCompanies,
        pagesPerCompany: num(filters.pagesPerCompany, route === COMPANY_WEBSITE_SOURCE_ID ? Math.min(12, Math.max(4, config.maxPages)) : 5),
      };
      Object.assign(baseStats, { maxCompanies, pagesPerCompany: sourceFilters.pagesPerCompany });
      let items;
      let nextCursor: string | null = null;
      try {
        const batch = await source.fetchBatch({ cursor, limit: maxCompanies, filters: sourceFilters });
        items = batch.items;
        nextCursor = batch.nextCursor;
      } catch (error) {
        return failure(describe(error), { ...baseStats, ...source.stats(), durationMs: Date.now() - start });
      }
      const sourceStats = source.stats();
      const checkedAt = new Date().toISOString();

      // Profiles, evaluated against the criteria; one per company identity within this run.
      const notCompanySites: string[] = [];
      const publicAuthorities: string[] = [];
      const excluded: Array<{ domain: string; by: string }> = [];
      const insufficient: Array<{ domain: string; name: string | null }> = [];
      const byIdentity = new Map<string, CompanyFacts>();
      for (const item of items) {
        const raw = item.raw;
        if (!looksLikeCompanySite(raw.pages)) { notCompanySites.push(item.externalId); if (route === COMPANY_SEARCH_SOURCE_ID) continue; }
        const profile = buildCompanyProfile(raw.pages, { website: raw.website, via: raw.via, query: raw.query, searchProvider: raw.searchProvider, searchSnippet: raw.searchSnippet, mode: route === COMPANY_SEARCH_SOURCE_ID ? 'search' : 'website', checkedAt });
        // A municipality or other public authority is not a company; a search never presents one as such.
        if (route === COMPANY_SEARCH_SOURCE_ID && isPublicAuthority(profile)) { publicAuthorities.push(profile.domain); continue; }
        const evaluation = evaluateCompany(profile, criteria, checkedAt);
        if (evaluation.excludedBy) { excluded.push({ domain: profile.domain, by: evaluation.excludedBy }); continue; }
        // A search keeps only companies with at least a possible match; a website the user named is always profiled.
        if (route === COMPANY_SEARCH_SOURCE_ID && evaluation.status === 'insufficient') { insufficient.push({ domain: profile.domain, name: profile.name }); continue; }
        const facts = withSearch(profile, criteria, evaluation, checkedAt);
        const earlier = byIdentity.get(facts.identity);
        byIdentity.set(facts.identity, earlier ? updateStoredCompany(earlier, facts).facts : facts);
      }

      // New, updated or unchanged against what this project already has (identity = domain, never the name).
      const existingByKey = new Map(input.existingRecords.map(record => [storedCompanyIdentityKey(record.domainData), record] as const).filter(([key]) => key !== null) as Array<[string, typeof input.existingRecords[number]]>);
      const fresh: CompanyFacts[] = [];
      const updated: DiscoveredRecord[] = [];
      const unchanged: DiscoveredRecord[] = [];
      for (const facts of byIdentity.values()) {
        const existing = existingByKey.get(`domain:${facts.identity}`);
        if (!existing) { fresh.push(facts); continue; }
        const stored = storedCompanyFacts(existing.domainData);
        if (!stored) { unchanged.push(recordFor(facts, existing.id)); continue; }
        const update = updateStoredCompany(stored, facts);
        // Unchanged: the stored profile stays as it is; this run's snapshot still shows this run's evaluation.
        if (update.changed) updated.push(recordFor(update.facts, existing.id));
        else unchanged.push(recordFor({ ...stored, search: facts.search, lastCheckedAt: checkedAt }, existing.id));
      }
      fresh.sort((a, b) => STATUS_ORDER[a.search?.status ?? 'insufficient'] - STATUS_ORDER[b.search?.status ?? 'insufficient']);
      const records = fresh.slice(0, config.targetRecords).map(facts => recordFor(facts));

      const all = [...byIdentity.values()];
      const byStatus = { confirmed: 0, possible: 0, insufficient: 0 };
      for (const facts of all) byStatus[facts.search?.status ?? 'insufficient']++;
      const queryErrors = sourceStats.queries.filter(q => q.error).length;
      const incompleteReasons = [
        ...(sourceStats.sitesFailed.length ? [`${sourceStats.sitesFailed.length} website(s) konden niet worden gelezen`] : []),
        ...(sourceStats.sitesIncomplete.length ? [`${sourceStats.sitesIncomplete.length} website(s) niet volledig doorlopen`] : []),
        ...(sourceStats.candidatesNotResearched ? [`${sourceStats.candidatesNotResearched} kandidaat-bedrijven wachten op een vervolgbatch`] : []),
        ...(sourceStats.timeLimitReached ? ['tijdslimiet bereikt'] : []),
        ...(queryErrors ? [`${queryErrors} zoekopdracht(en) mislukt`] : []),
      ];
      return {
        records,
        updatedRecords: updated,
        observedRecords: unchanged,
        continuation: nextCursor ? { cursor: nextCursor, remaining: sourceStats.candidatesNotResearched } : null,
        ...(incompleteReasons.length ? { status: 'partial' as const } : {}),
        stats: {
          ...baseStats,
          ...sourceStats,
          notCompanySites, publicAuthorities, excludedByCriteria: excluded, insufficientCandidates: insufficient.slice(0, 20), insufficientCount: insufficient.length,
          companiesFound: all.length, byStatus,
          coverageComplete: incompleteReasons.length === 0, incompleteReasons,
          yield: all.length === 0 ? 'no_matches' : byStatus.confirmed > 0 ? 'confirmed_matches' : 'possible_matches_only',
          duplicatesUnchanged: unchanged.length, duplicates: unchanged.length + updated.length, companiesToUpdate: updated.length,
          recordsAccepted: records.length, recordsCreated: records.length,
          durationMs: Date.now() - start,
          stopReason: sourceStats.timeLimitReached ? 'time_limit' : sourceStats.candidatesNotResearched ? 'candidate_limit' : fresh.length > config.targetRecords ? 'target_reached' : 'no_more_candidates',
        },
      };
    },
  };
}

export const companiesAdapter: DomainAdapter = createCompaniesAdapter();
