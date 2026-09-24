/**
 * The tenders module's DomainAdapter: one run pulls tenders from a DiscoverySource (TenderNed, TED, a website crawl or a
 * web search), turns them into TenderFacts, merges publications of the same tender into one record, updates tenders that
 * are already stored with newer publications (or leaves them alone when nothing changed), and hands the result to the
 * generic run/record persistence in routes/runs.ts.
 *
 * Three ways in, one pipeline:
 *  - `source` runs name a source (`tenderned`, `ted`, `website`, `search`) or `auto` (several suitable sources);
 *  - a `website` run (a URL) is the `website` source, a `branch` run (branch/keywords/region/country) is the `search` source.
 * The website and search sources use the platform's crawl engine (server configuration only) and search provider.
 */
import {
  collectFromSource, createConfiguredSearchProvider, createDiscoveryCrawler, parseCrawlerEngine, SourceError,
  type DiscoveryCrawler, type DiscoverySource, type SourceSearchProvider, type HttpTransport,
} from '@discovery-platform/core';
import {
  mergeTenderPublications, planTenderSearch, tenderOpportunityStatus, storedTenderFacts, storedTenderIdentityKey, tenderCompletenessScore, tenderIdentityKey, tenderMatchesKeywords,
  updateStoredTender, TENDER_SOURCES, type TenderFacts, type TenderSourceDefinition,
} from '@discovery-platform/domain-tenders';
import type { DiscoveredRecord, DiscoveryRunInput, DiscoveryRunOutcome, DomainAdapter } from '../domain-registry.js';
import type { DiscoveryRunConfig } from '../discovery-run-config.js';

/** Every source a `source` run may name (see TENDER_SOURCES in domains/tenders); the id is the only thing a request chooses. */
export type TenderSource = DiscoverySource<any> & { stats?(): object };
export interface TendersAdapterOptions {
  /** Replaces how a known source is created (tests inject a fake network); how its items are mapped stays the domain's. */
  sources?: Record<string, () => TenderSource>;
  /** Test seams for the web sources: the crawl engine, search provider, transport and clock they use instead of the configured ones. */
  web?: { crawler?: DiscoveryCrawler; searchProvider?: SourceSearchProvider; transport?: HttpTransport; clock?: { now(): number; sleep(ms: number): Promise<unknown> } };
}

const BATCH_SIZE = 25;
const MAX_ITEMS_PER_RUN = 200;
export const AUTO_SOURCE_ID = 'auto';

/** The crawl engine from server-side configuration only, exactly as the vacancies module does. */
function configuredCrawler(): DiscoveryCrawler {
  const concurrency = Number.parseInt(process.env.DISCOVERY_CRAWLER_CONCURRENCY ?? '', 10);
  return createDiscoveryCrawler(parseCrawlerEngine(process.env.DISCOVERY_CRAWLER_ENGINE), Number.isFinite(concurrency) ? { maxConcurrency: concurrency } : {});
}
/**
 * The web search provider from server-side configuration only: Tavily or Brave, chosen by SEARCH_PROVIDER, or
 * whichever of TAVILY_API_KEY/BRAVE_SEARCH_API_KEY is set when SEARCH_PROVIDER is not (see createConfiguredSearchProvider
 * in the core — this file never talks to either provider's API itself). Read lazily so a missing key only matters
 * when a search is actually requested.
 */
function configuredSearchProvider(): SourceSearchProvider | undefined {
  return createConfiguredSearchProvider({
    provider: process.env.SEARCH_PROVIDER === 'brave' || process.env.SEARCH_PROVIDER === 'tavily' ? process.env.SEARCH_PROVIDER : undefined,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
  });
}

interface Collected {
  sourceId: string;
  source: TenderSource;
  definition: TenderSourceDefinition;
  publications: TenderFacts[];
  fetched: number;
  batches: number;
  stopReason: string;
  nextCursor: string | null;
  exhausted: boolean;
  stats: Record<string, unknown>;
}

const isKnownSource = (id: string) => Object.hasOwn(TENDER_SOURCES, id);
const failure = (error: string, stats: Record<string, unknown>): DiscoveryRunOutcome => ({ status: 'failed', error, records: [], stats });
/** A source that could not be read, with the statistics gathered so far. */
class CollectFailure extends Error {
  constructor(readonly reason: unknown, readonly stats: Record<string, unknown>) { super('collect failed'); }
}
/** What a user is told: invalid filters and a missing search provider plainly, anything else with its error code. */
const describe = (error: unknown) => (error instanceof SourceError ? (error.code === 'invalid_filters' ? error.message : `${error.code}: ${error.message}`) : 'De bron kon niet worden gelezen.');

export function createTendersAdapter(options: TendersAdapterOptions = {}): DomainAdapter {
  const overrides = options.sources ?? {};
  const web = () => ({ crawler: options.web?.crawler ?? configuredCrawler(), searchProvider: options.web?.searchProvider ?? configuredSearchProvider(), transport: options.web?.transport, clock: options.web?.clock });

  /** Runs one source with `filters` and maps what it returned. Throws a SourceError for invalid filters or an unreadable source. */
  async function collect(sourceId: string, filters: Record<string, unknown>, config: DiscoveryRunConfig, start: number, mode: 'website' | 'search' | 'auto'): Promise<Collected> {
    const definition = TENDER_SOURCES[sourceId];
    const source = (overrides[sourceId] ?? (() => definition.create(sourceId === 'website' || sourceId === 'search' ? web() : undefined)))();
    const stats: Record<string, unknown> = {
      searchMode: 'source', sourceId: source.id, sourceKind: source.kind, targetRecords: config.targetRecords, maxCandidates: config.maxCandidates, maxDurationMs: config.maxDurationMs,
    };
    Object.assign(stats, definition.describeFilters(filters));
    let collected;
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(config.maxDurationMs)));
      const bounded: TenderSource = { ...source, async fetchBatch(request) {
        try { return await source.fetchBatch(request); }
        catch (error) {
          if (signal.aborted) return { items: [], nextCursor: request.cursor, exhausted: false };
          throw error;
        }
      } };
      collected = await collectFromSource(bounded, {
        filters, batchSize: BATCH_SIZE, maxItems: Math.min(config.maxCandidates, MAX_ITEMS_PER_RUN), maxDurationMs: config.maxDurationMs,
        maxBatches: 20, signal,
      });
      if (signal.aborted) collected.stopReason = 'time_limit';
    } catch (error) {
      throw new CollectFailure(error, { ...stats, ...source.stats?.(), durationMs: Date.now() - start });
    }
    // A page tender also records how the run that found it was started (its own source, or the automatic mode).
    const publications = collected.items.map(item => definition.map(item)).filter((fact): fact is TenderFacts => fact !== null)
      .map(fact => (fact.discovery ? { ...fact, discovery: { ...fact.discovery, mode } } : fact));
    return {
      sourceId, source, definition, publications, fetched: collected.items.length, batches: collected.batches, stopReason: collected.stopReason,
      nextCursor: collected.nextCursor, exhausted: collected.exhausted, stats: { ...stats, ...source.stats?.() },
    };
  }

  /** The filters a source is given: the run's own filters plus the limits of the run configuration the web sources honour. */
  function filtersFor(sourceId: string, filters: Record<string, unknown>, config: DiscoveryRunConfig): Record<string, unknown> {
    if (sourceId === 'website') return { maxPages: config.maxPages, maxCandidates: config.maxCandidates, maxDurationMs: config.maxDurationMs, targetRecords: config.targetRecords, ...filters };
    if (sourceId === 'search') return { maxDurationMs: config.maxDurationMs, targetRecords: config.targetRecords, ...filters };
    return filters;
  }

  return {
    id: 'tenders',
    async runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunOutcome> {
      const start = Date.now();
      const config = input.runConfig;

      // Which source(s), with which filters, for this request shape.
      let sourceId: string;
      let filters: Record<string, unknown>;
      if (input.mode === 'source') { sourceId = input.sourceId; filters = input.filters; }
      else if (input.mode === 'website') { sourceId = 'website'; filters = { ...input.filters, url: input.sourceUrl }; }
      else { sourceId = 'search'; filters = { ...input.filters, branch: input.branch, keywords: input.keywords, region: input.region, country: input.country ?? input.filters.country }; }
      const modeStats = { searchMode: input.mode === 'branch' ? 'branch' : input.mode === 'website' ? 'website' : 'source' };

      if (sourceId !== AUTO_SOURCE_ID && !isKnownSource(sourceId)) {
        return failure(`Onbekende bron "${sourceId}".`, { searchMode: 'source', sourceId });
      }

      const groups: Collected[] = [];
      const sourceReports: Array<Record<string, unknown>> = [];
      const baseStats: Record<string, unknown> = { ...modeStats, sourceId, targetRecords: config.targetRecords, maxCandidates: config.maxCandidates, maxDurationMs: config.maxDurationMs };
      let keywordFilter: string | null = null;
      let cpvCategories: string[] = [];

      const apiFirst = sourceId === AUTO_SOURCE_ID || sourceId === 'search';
      if (sourceId === 'search' && ![filters.branch, filters.keywords].some(v => typeof v === 'string' && v.trim()) && !(Array.isArray(filters.cpvPrefixes) && filters.cpvPrefixes.length)) {
        return failure('Geef een branche of zoektermen of CPV-categorie op.', baseStats);
      }
      if (apiFirst) {
        let plan;
        try { plan = planTenderSearch(filters, web().searchProvider !== undefined || overrides.search !== undefined); }
        catch (error) { return failure(describe(error), baseStats); }
        Object.assign(baseStats, plan.stats);
        keywordFilter = plan.stats.keywords;
        cpvCategories = plan.stats.cpvPrefixes;
        for (const step of plan.steps) {
          try {
            const remaining = config.maxDurationMs - (Date.now() - start);
            if (remaining <= 0) { sourceReports.push({ sourceId: step.sourceId, status: 'skipped', reason: 'Tijdslimiet bereikt.' }); continue; }
            const budget = { ...config, maxDurationMs: Math.max(1, Math.min(remaining, Math.floor(config.maxDurationMs / plan.steps.length))) };
            const collected = await collect(step.sourceId, filtersFor(step.sourceId, step.filters, budget), budget, start, sourceId === 'search' ? 'search' : 'auto');
            groups.push(collected);
            sourceReports.push({ sourceId: step.sourceId, status: 'ok', publications: collected.fetched, stopReason: collected.stopReason, exhausted: collected.exhausted });
          } catch (error) {
            const reason = error instanceof CollectFailure ? error.reason : error;
            sourceReports.push({ sourceId: step.sourceId, status: 'failed', error: describe(reason).slice(0, 300), ...(error instanceof CollectFailure ? { stats: error.stats } : {}) });
          }
        }
        for (const skipped of plan.skipped) sourceReports.push({ sourceId: skipped.sourceId, status: 'skipped', reason: skipped.reason });
        if (groups.length === 0) return { ...failure('Geen enkele bron kon worden gelezen.', { ...baseStats, sources: sourceReports, durationMs: Date.now() - start }) };
      } else {
        try {
          groups.push(await collect(sourceId, filtersFor(sourceId, filters, config), config, start, sourceId === 'search' ? 'search' : 'website'));
        } catch (error) {
          return failure(describe(error instanceof CollectFailure ? error.reason : error), error instanceof CollectFailure ? error.stats : baseStats);
        }
      }

      const existingByKey = new Map<string, { id: string; domainData: Record<string, unknown> }>();
      for (const existing of input.existingRecords) {
        const key = storedTenderIdentityKey(existing.domainData);
        if (key && !existingByKey.has(key)) existingByKey.set(key, existing);
      }

      const recordFor = (fact: TenderFacts, existingRecordId: string | undefined, publications = fact.publications): DiscoveredRecord => {
        const completeness = tenderCompletenessScore(fact);
        // Provenance per record: the source that found it (a page also keeps how: crawled directly or via a search).
        const label = fact.sourceSystem === 'website' && fact.discovery?.via === 'web_search' ? 'search' : fact.sourceSystem;
        const sourceType = fact.sourceSystem === 'website' ? 'website' : 'api';
        const data = (p: { publicationId: string; noticeType: string | null }) => ({ tenderIdentity: fact.tenderIdentity, publicationId: p.publicationId, noticeType: p.noticeType, ...(fact.discovery ? { discovery: fact.discovery } : {}) });
        return {
          existingRecordId,
          displayName: fact.title ?? fact.contractingAuthority,
          domainData: fact as unknown as Record<string, unknown>,
          classification: { presentSignals: completeness.presentSignals, missingSignals: completeness.missingSignals },
          score: completeness.score,
          // A new record starts with one source naming all its publications; an update adds one per NEW publication.
          sources: existingRecordId
            ? publications.map(p => ({ sourceType, sourceUrl: p.sourceUrl, sourceLabel: label, sourceData: data(p) }))
            : [{ sourceType, sourceUrl: fact.sourceUrl, sourceLabel: label, sourceData: { tenderIdentity: fact.tenderIdentity, publicationIds: fact.publications.map(p => p.publicationId), ...(fact.discovery ? { discovery: fact.discovery } : {}) } }],
          contacts: [],
        };
      };

      const allPublications = groups.flatMap(group => group.publications);
      let tenders = mergeTenderPublications(allPublications);
      let filteredByKeywords = 0;
      if (keywordFilter) {
        // TenderNed keeps its existing client-side text check; TED already applied full-text server-side.
        const before = tenders.length;
        tenders = tenders.filter(fact => fact.sourceSystem !== 'tenderned' || tenderMatchesKeywords(fact, keywordFilter));
        filteredByKeywords = before - tenders.length;
      }
      const freshBySource = new Map<string, DiscoveredRecord[]>();
      const updated: DiscoveredRecord[] = [];
      const unchanged: DiscoveredRecord[] = [];
      for (const fact of tenders) {
        const existing = existingByKey.get(tenderIdentityKey(fact));
        if (!existing) {
          const list = freshBySource.get(fact.sourceSystem) ?? [];
          list.push(recordFor(fact, undefined));
          freshBySource.set(fact.sourceSystem, list);
          continue;
        }
        // The tender is stored already: merge this run's publications into it by the usual rule (newest publication
        // with a value wins, earlier information stays); write only when that changes something.
        const stored = storedTenderFacts(existing.domainData);
        if (!stored) { unchanged.push(recordFor(fact, existing.id)); continue; }
        const update = updateStoredTender(stored, fact);
        if (update.changed) updated.push(recordFor(update.facts, existing.id, update.newPublications));
        else unchanged.push(recordFor(stored, existing.id));
      }
      // Official records take priority; web results supplement remaining capacity.
      const lists = [...freshBySource].sort(([a], [b]) => Number(a === 'website') - Number(b === 'website')).map(([, list]) => list);
      const totalFresh = lists.reduce((sum, list) => sum + list.length, 0);
      const records: DiscoveredRecord[] = [];
      for (const list of lists) records.push(...list.slice(0, Math.max(0, config.targetRecords - records.length)));
      const primary = groups[0];
      const anyCut = groups.some(group => group.stopReason === 'item_limit');
      const stopReason = totalFresh > config.targetRecords ? 'target_reached'
        : groups.every(group => group.stopReason === 'exhausted') ? 'no_more_candidates'
        : anyCut ? 'candidate_limit'
        : groups.some(group => group.stopReason === 'time_limit') ? 'time_limit' : primary.stopReason;
      const failedSources = sourceReports.filter(report => report.status === 'failed').length;
      const single = groups.length === 1 && !apiFirst;
      const coverageComplete = groups.every(group => group.exhausted && group.stopReason !== 'time_limit' && Number(group.stats.detailFailures ?? 0) === 0) && failedSources === 0 && !sourceReports.some(r => r.reason === 'Tijdslimiet bereikt.');
      const opportunityStatus = { open: 0, expired: 0, unknown: 0 };
      for (const fact of tenders) opportunityStatus[tenderOpportunityStatus(fact)]++;
      const officialTenders = tenders.filter(fact => fact.sourceSystem !== 'website').length;
      const webResults = tenders.length - officialTenders;
      const openRelevant = tenders.filter(fact => tenderOpportunityStatus(fact) === 'open' && (fact.sourceSystem !== 'website' || (fact.discovery?.locationConfidence === 'confirmed' && (cpvCategories.length === 0 || fact.cpvCodes.some(c => cpvCategories.some(p => c.code.startsWith(p))))))).length;
      return {
        records,
        observedRecords: unchanged,
        updatedRecords: updated,
        ...(!coverageComplete ? { status: 'partial' as const } : {}),
        stats: {
          ...(single ? primary.stats : { ...baseStats, ...Object.assign({}, ...groups.map(group => ({ [`source_${group.sourceId}`]: group.stats }))) }),
          searchMode: modeStats.searchMode,
          ...(sourceReports.length > 0 ? { sources: sourceReports } : {}),
          batches: groups.reduce((sum, group) => sum + group.batches, 0),
          publicationsFetched: groups.reduce((sum, group) => sum + group.fetched, 0),
          publicationsMapped: allPublications.length,
          tendersFound: tenders.length,
          officialTenders, webResults, opportunityStatus, openRelevant, coverageComplete,
          yield: tenders.length === 0 ? 'no_matches' : openRelevant > 0 ? 'open_matches' : 'no_confirmed_open_matches',
          publicationsMergedIntoOtherPublications: allPublications.length - mergeTenderPublications(allPublications).length,
          filteredByKeywords,
          // recordsCreated is set by the run route from what it actually stored, next to recordsUpdated.
          duplicatesUnchanged: unchanged.length,
          duplicatesAgainstExisting: unchanged.length + updated.length,
          duplicates: unchanged.length + updated.length,
          tendersToUpdate: updated.length,
          candidatesDiscovered: tenders.length,
          recordsAccepted: records.length,
          recordsCreated: records.length,
          recordsBySource: Object.fromEntries([...freshBySource].map(([id, list]) => [id, list.length])),
          nextCursor: single ? primary.nextCursor : null,
          exhausted: groups.every(group => group.exhausted),
          durationMs: Date.now() - start,
          stopReason,
        },
      };
    },
  };
}

export const tendersAdapter: DomainAdapter = createTendersAdapter();
