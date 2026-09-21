import type { DiscoverySource, SourceItem } from '@discovery-platform/core';
import type { TenderFacts } from './tender-facts.js';
import { createTenderNedSource, parseTenderNedFilters, TENDERNED_SOURCE_ID } from './tenderned-source.js';
import { mapTenderNedPublication } from './tenderned-map.js';
import { createTedSource, parseTedFilters, TED_SOURCE_ID } from './ted-source.js';
import { mapTedNotice } from './ted-map.js';

/**
 * The tender sources a run may name (`sourceId`), each with everything the tenders adapter needs from it: how to create
 * it, how to turn one of its items into TenderFacts, and how to validate its filters (reporting the effective ones).
 * Every source keeps its own identity space (`TenderFacts.sourceSystem`): records of different sources are never
 * merged by identity, see docs/tenders-domain.md ("Cross-source matching").
 */
export interface TenderSourceDefinition {
  id: string;
  create(): DiscoverySource<any> & { stats?(): object };
  map(item: SourceItem<any>): TenderFacts | null;
  /** Validates the run filters (throws a SourceError `invalid_filters`) and returns the effective ones for the run statistics. */
  describeFilters(filters: Record<string, unknown>): Record<string, unknown>;
}

export const TENDER_SOURCES: Record<string, TenderSourceDefinition> = {
  [TENDERNED_SOURCE_ID]: {
    id: TENDERNED_SOURCE_ID,
    create: () => createTenderNedSource(),
    map: mapTenderNedPublication,
    describeFilters: filters => { const f = parseTenderNedFilters(filters); return { publishedFrom: f.publishedFrom, publishedTo: f.publishedTo }; },
  },
  [TED_SOURCE_ID]: {
    id: TED_SOURCE_ID,
    create: () => createTedSource(),
    map: mapTedNotice,
    describeFilters: filters => { const f = parseTedFilters(filters); return { publishedFrom: f.publishedFrom, publishedTo: f.publishedTo, country: f.country }; },
  },
};
