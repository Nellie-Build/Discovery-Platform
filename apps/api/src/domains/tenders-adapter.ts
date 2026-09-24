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
  collectFromSource, createBraveSearchProvider, createDiscoveryCrawler, parseCrawlerEngine, SourceError,
  type DiscoveryCrawler, type DiscoverySource, type SourceSearchProvider, type HttpTransport,
} from '@discovery-platform/core';
import {
  mergeTenderPublications, resolveCountry, storedTenderFacts, storedTenderIdentityKey, tenderCompletenessScore, tenderIdentityKey, tenderMatchesKeywords,
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
const AUTO_SOURCES = ['tenderned', 'ted', 'search'] as const;

/** The crawl engine from server-side configuration only, exactly as the vacancies module does. */
function configuredCrawler(): DiscoveryCrawler {
  const concurrency = Number.parseInt(process.env.DISCOVERY_CRAWLER_CONCURRENCY ?? '', 10);
  return createDiscoveryCrawler(parseCrawlerEngine(process.env.DISCOVERY_CRAWLER_ENGINE), Number.isFinite(concurrency) ? { maxConcurrency: concurrency } : {});
}
/** Read lazily so a missing key only matters when a search is actually requested. */
function configuredSearchProvider(): SourceSearchProvider | undefined {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  return apiKey ? createBraveSearchProvider(apiKey) : undefined;
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
      collected = await collectFromSource(source, {
        filters, batchSize: BATCH_SIZE, maxItems: Math.min(config.maxCandidates, MAX_ITEMS_PER_RUN), maxDurationMs: config.maxDurationMs,
      });
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

      if (sourceId === AUTO_SOURCE_ID) {
        const plan = planAuto(filters, web().searchProvider !== undefined || overrides.search !== undefined);
        if ('error' in plan) return failure(plan.error, baseStats);
        Object.assign(baseStats, plan.stats);
        keywordFilter = plan.keywords;
        for (const step of plan.steps) {
          try {
            const collected = await collect(step.sourceId, filtersFor(step.sourceId, step.filters, config), config, start, 'auto');
            groups.push(collected);
            sourceReports.push({ sourceId: step.sourceId, status: 'ok', publications: collected.fetched, stopReason: collected.stopReason });
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
        // Keywords narrow what the API sources return (they cannot search by text); pages found by the search already matched them.
        const before = tenders.length;
        tenders = tenders.filter(fact => fact.sourceSystem === 'website' || tenderMatchesKeywords(fact, keywordFilter));
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
      // The target is shared fairly between sources (one each in turn) so a large API result never crowds out a website or search result.
      const lists = [...freshBySource.values()];
      const totalFresh = lists.reduce((sum, list) => sum + list.length, 0);
      const records: DiscoveredRecord[] = [];
      for (let index = 0; records.length < config.targetRecords && records.length < totalFresh; index++) {
        for (const list of lists) if (index < list.length && records.length < config.targetRecords) records.push(list[index]);
      }
      const primary = groups[0];
      const anyCut = groups.some(group => group.stopReason === 'item_limit');
      const stopReason = totalFresh > config.targetRecords ? 'target_reached'
        : groups.every(group => group.stopReason === 'exhausted') ? 'no_more_candidates'
        : anyCut ? 'candidate_limit'
        : groups.some(group => group.stopReason === 'time_limit') ? 'time_limit' : primary.stopReason;
      const failedSources = sourceReports.filter(report => report.status === 'failed').length;
      const single = groups.length === 1 && sourceId !== AUTO_SOURCE_ID;
      return {
        records,
        observedRecords: unchanged,
        updatedRecords: updated,
        ...(failedSources > 0 ? { status: 'partial' as const } : {}),
        stats: {
          ...(single ? primary.stats : { ...baseStats, ...Object.assign({}, ...groups.map(group => ({ [`source_${group.sourceId}`]: group.stats }))) }),
          searchMode: modeStats.searchMode,
          ...(sourceReports.length > 0 ? { sources: sourceReports } : {}),
          batches: groups.reduce((sum, group) => sum + group.batches, 0),
          publicationsFetched: groups.reduce((sum, group) => sum + group.fetched, 0),
          publicationsMapped: allPublications.length,
          tendersFound: tenders.length,
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

interface AutoStep { sourceId: string; filters: Record<string, unknown> }
type AutoPlan = { steps: AutoStep[]; skipped: Array<{ sourceId: string; reason: string }>; keywords: string | null; stats: Record<string, unknown> } | { error: string };

/**
 * `auto`: every source that suits the request. TenderNed for the Netherlands, TED for the country, and the web search when a
 * branch or keywords were given and a search provider is configured. Each step gets only the filters it understands.
 */
function planAuto(filters: Record<string, unknown>, searchAvailable: boolean): AutoPlan {
  let country;
  try { country = resolveCountry(filters.country); } catch (error) { return { error: error instanceof SourceError ? error.message : 'Ongeldig land.' }; }
  const wanted = Array.isArray(filters.sources) ? filters.sources.filter((id): id is string => typeof id === 'string') : [...AUTO_SOURCES];
  const unknown = wanted.filter(id => !(AUTO_SOURCES as readonly string[]).includes(id));
  if (unknown.length > 0) return { error: `Onbekende bron in "sources": ${unknown.join(', ').slice(0, 80)}.` };
  const period = { ...(filters.publishedFrom !== undefined ? { publishedFrom: filters.publishedFrom } : {}), ...(filters.publishedTo !== undefined ? { publishedTo: filters.publishedTo } : {}) };
  const cpv = filters.cpvPrefixes !== undefined ? { cpvPrefixes: filters.cpvPrefixes } : {};
  const nuts = filters.nutsPrefixes !== undefined ? { nutsPrefixes: filters.nutsPrefixes } : {};
  const hasText = [filters.branch, filters.keywords].some(value => typeof value === 'string' && value.trim());
  const steps: AutoStep[] = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  for (const id of AUTO_SOURCES) {
    if (!wanted.includes(id)) continue;
    if (id === 'tenderned') { if (country.code === 'NL') steps.push({ sourceId: id, filters: { ...period, ...cpv, ...nuts } }); else skipped.push({ sourceId: id, reason: 'TenderNed publiceert alleen Nederlandse aanbestedingen.' }); }
    else if (id === 'ted') steps.push({ sourceId: id, filters: { ...period, ...cpv, ...nuts, country: country.alpha3 } });
    else if (!hasText) skipped.push({ sourceId: id, reason: 'Web-zoeken heeft een branche of zoektermen nodig.' });
    else if (!searchAvailable) skipped.push({ sourceId: id, reason: 'Er is geen zoekprovider geconfigureerd.' });
    else steps.push({ sourceId: id, filters: { ...filters, ...period } });
  }
  if (steps.length === 0) return { error: 'Geen enkele bron past bij deze zoekopdracht.' };
  const keywords = typeof filters.keywords === 'string' && filters.keywords.trim() ? filters.keywords.trim() : null;
  return { steps, skipped, keywords, stats: { branch: filters.branch ?? null, keywords, region: filters.region ?? null, country: country.code, cpvPrefixes: filters.cpvPrefixes ?? [] } };
}

export const tendersAdapter: DomainAdapter = createTendersAdapter();
