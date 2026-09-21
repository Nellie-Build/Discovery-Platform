/**
 * The tenders module's DomainAdapter (MVP): one `source` run pulls publications from a DiscoverySource
 * (TenderNed today), turns them into TenderFacts, merges publications of the same tender into one record,
 * skips tenders that are already stored, and hands the result to the generic run/record persistence in
 * routes/runs.ts. No crawler and no vacancy code is involved.
 */
import { collectFromSource, SourceError, type DiscoverySource } from '@discovery-platform/core';
import {
  createTenderNedSource, mapTenderNedPublication, mergeTenderPublications, parseTenderNedFilters,
  storedTenderIdentityKey, tenderCompletenessScore, tenderIdentityKey, TENDERNED_SOURCE_ID,
  type TenderFacts, type TenderNedRaw,
} from '@discovery-platform/domain-tenders';
import type { DiscoveredRecord, DiscoveryRunInput, DiscoveryRunOutcome, DomainAdapter } from '../domain-registry.js';

/** Every source a `source` run may name; the id is the only thing a request chooses. */
export type TenderSource = DiscoverySource<TenderNedRaw> & { stats?(): object };
export interface TendersAdapterOptions {
  sources?: Record<string, () => TenderSource>;
}

const BATCH_SIZE = 25;
const MAX_ITEMS_PER_RUN = 200;

export function createTendersAdapter(options: TendersAdapterOptions = {}): DomainAdapter {
  const sources: Record<string, () => TenderSource> = options.sources ?? { [TENDERNED_SOURCE_ID]: () => createTenderNedSource() };
  return {
    id: 'tenders',
    async runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunOutcome> {
      if (input.mode !== 'source') {
        return { status: 'failed', error: 'Aanbestedingen ondersteunt alleen bronruns (sourceId).', records: [], stats: { searchMode: input.mode } };
      }
      const start = Date.now();
      const factory = sources[input.sourceId];
      if (!factory) {
        return { status: 'failed', error: `Onbekende bron "${input.sourceId}".`, records: [], stats: { searchMode: 'source', sourceId: input.sourceId } };
      }
      const source = factory();
      const config = input.runConfig;
      const stats: Record<string, unknown> = {
        searchMode: 'source', sourceId: source.id, sourceKind: source.kind, targetRecords: config.targetRecords, maxCandidates: config.maxCandidates, maxDurationMs: config.maxDurationMs,
      };
      if (source.id === TENDERNED_SOURCE_ID) {
        try {
          const range = parseTenderNedFilters(input.filters);
          stats.publishedFrom = range.publishedFrom;
          stats.publishedTo = range.publishedTo;
        } catch (error) {
          return { status: 'failed', error: error instanceof Error ? error.message : 'Ongeldige filters.', records: [], stats };
        }
      }

      let collected;
      try {
        collected = await collectFromSource<TenderNedRaw>(source, {
          filters: input.filters, batchSize: BATCH_SIZE, maxItems: Math.min(config.maxCandidates, MAX_ITEMS_PER_RUN),
          maxDurationMs: config.maxDurationMs,
        });
      } catch (error) {
        const message = error instanceof SourceError ? `${error.code}: ${error.message}` : 'De bron kon niet worden gelezen.';
        return { status: 'failed', error: message, records: [], stats: { ...stats, ...source.stats?.(), durationMs: Date.now() - start } };
      }

      const publications = collected.items.map(item => mapTenderNedPublication(item)).filter((fact): fact is TenderFacts => fact !== null);
      const tenders = mergeTenderPublications(publications);
      const existingByKey = new Map<string, string>();
      for (const existing of input.existingRecords) {
        const key = storedTenderIdentityKey(existing.domainData);
        if (key && !existingByKey.has(key)) existingByKey.set(key, existing.id);
      }

      const fresh: DiscoveredRecord[] = [];
      const observed: DiscoveredRecord[] = [];
      for (const fact of tenders) {
        const completeness = tenderCompletenessScore(fact);
        const existingRecordId = existingByKey.get(tenderIdentityKey(fact));
        const record: DiscoveredRecord = {
          existingRecordId,
          displayName: fact.title ?? fact.contractingAuthority,
          domainData: fact as unknown as Record<string, unknown>,
          classification: { presentSignals: completeness.presentSignals, missingSignals: completeness.missingSignals },
          score: completeness.score,
          sources: [{
            sourceType: source.kind, sourceUrl: fact.sourceUrl, sourceLabel: source.id,
            sourceData: { tenderIdentity: fact.tenderIdentity, publicationIds: fact.publications.map(p => p.publicationId) },
          }],
          contacts: [],
        };
        if (existingRecordId) observed.push(record); else fresh.push(record);
      }
      const records = fresh.slice(0, config.targetRecords);
      const stopReason = fresh.length > config.targetRecords ? 'target_reached'
        : collected.stopReason === 'exhausted' ? 'no_more_candidates'
        : collected.stopReason === 'item_limit' ? 'candidate_limit'
        : collected.stopReason === 'time_limit' ? 'time_limit' : collected.stopReason;
      return {
        records,
        observedRecords: observed,
        stats: {
          ...stats,
          ...source.stats?.(),
          batches: collected.batches,
          publicationsFetched: collected.items.length,
          publicationsMapped: publications.length,
          tendersFound: tenders.length,
          publicationsMergedIntoOtherPublications: publications.length - tenders.length,
          duplicatesAgainstExisting: observed.length,
          duplicates: observed.length,
          candidatesDiscovered: tenders.length,
          recordsAccepted: records.length,
          recordsCreated: records.length,
          nextCursor: collected.nextCursor,
          exhausted: collected.exhausted,
          durationMs: Date.now() - start,
          stopReason,
        },
      };
    },
  };
}

export const tendersAdapter: DomainAdapter = createTendersAdapter();
