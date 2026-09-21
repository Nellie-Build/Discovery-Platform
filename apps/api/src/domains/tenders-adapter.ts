/**
 * The tenders module's DomainAdapter (MVP): one `source` run pulls publications from a DiscoverySource
 * (TenderNed today), turns them into TenderFacts, merges publications of the same tender into one record,
 * updates tenders that are already stored with newer publications (or leaves them alone when nothing changed),
 * and hands the result to the generic run/record persistence in routes/runs.ts. No crawler and no vacancy code is involved.
 */
import { collectFromSource, SourceError, type DiscoverySource } from '@discovery-platform/core';
import {
  createTenderNedSource, mapTenderNedPublication, mergeTenderPublications, parseTenderNedFilters,
  storedTenderFacts, storedTenderIdentityKey, tenderCompletenessScore, tenderIdentityKey, updateStoredTender, TENDERNED_SOURCE_ID,
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
      const existingByKey = new Map<string, { id: string; domainData: Record<string, unknown> }>();
      for (const existing of input.existingRecords) {
        const key = storedTenderIdentityKey(existing.domainData);
        if (key && !existingByKey.has(key)) existingByKey.set(key, existing);
      }

      const recordFor = (fact: TenderFacts, existingRecordId: string | undefined, publications = fact.publications): DiscoveredRecord => {
        const completeness = tenderCompletenessScore(fact);
        return {
          existingRecordId,
          displayName: fact.title ?? fact.contractingAuthority,
          domainData: fact as unknown as Record<string, unknown>,
          classification: { presentSignals: completeness.presentSignals, missingSignals: completeness.missingSignals },
          score: completeness.score,
          // A new record starts with one source naming all its publications; an update adds one per NEW publication.
          sources: existingRecordId
            ? publications.map(p => ({ sourceType: source.kind, sourceUrl: p.sourceUrl, sourceLabel: source.id, sourceData: { tenderIdentity: fact.tenderIdentity, publicationId: p.publicationId, noticeType: p.noticeType } }))
            : [{ sourceType: source.kind, sourceUrl: fact.sourceUrl, sourceLabel: source.id, sourceData: { tenderIdentity: fact.tenderIdentity, publicationIds: fact.publications.map(p => p.publicationId) } }],
          contacts: [],
        };
      };
      const fresh: DiscoveredRecord[] = [];
      const updated: DiscoveredRecord[] = [];
      const unchanged: DiscoveredRecord[] = [];
      for (const fact of tenders) {
        const existing = existingByKey.get(tenderIdentityKey(fact));
        if (!existing) { fresh.push(recordFor(fact, undefined)); continue; }
        // The tender is stored already: merge this run's publications into it by the usual rule (newest publication
        // with a value wins, earlier information stays); write only when that changes something.
        const stored = storedTenderFacts(existing.domainData);
        if (!stored) { unchanged.push(recordFor(fact, existing.id)); continue; }
        const update = updateStoredTender(stored, fact);
        if (update.changed) updated.push(recordFor(update.facts, existing.id, update.newPublications));
        else unchanged.push(recordFor(stored, existing.id));
      }
      const records = fresh.slice(0, config.targetRecords);
      const stopReason = fresh.length > config.targetRecords ? 'target_reached'
        : collected.stopReason === 'exhausted' ? 'no_more_candidates'
        : collected.stopReason === 'item_limit' ? 'candidate_limit'
        : collected.stopReason === 'time_limit' ? 'time_limit' : collected.stopReason;
      return {
        records,
        observedRecords: unchanged,
        updatedRecords: updated,
        stats: {
          ...stats,
          ...source.stats?.(),
          batches: collected.batches,
          publicationsFetched: collected.items.length,
          publicationsMapped: publications.length,
          tendersFound: tenders.length,
          publicationsMergedIntoOtherPublications: publications.length - tenders.length,
          // recordsCreated is set by the run route from what it actually stored, next to recordsUpdated.
          duplicatesUnchanged: unchanged.length,
          duplicatesAgainstExisting: unchanged.length + updated.length,
          duplicates: unchanged.length + updated.length,
          tendersToUpdate: updated.length,
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
