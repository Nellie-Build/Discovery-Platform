import { createDiscoveryCrawler, parseCrawlerEngine, type DiscoverySource, type SourceItem } from '@discovery-platform/core';
import type { TenderFacts } from './tender-facts.js';
import { createTenderNedSource, parseTenderNedFilters, TENDERNED_SOURCE_ID } from './tenderned-source.js';
import { mapTenderNedPublication } from './tenderned-map.js';
import { createTedSource, parseTedFilters, TED_SOURCE_ID } from './ted-source.js';
import { mapTedNotice } from './ted-map.js';
import { mapTenderPage, SEARCH_SOURCE_ID, WEBSITE_SOURCE_ID } from './tender-page.js';
import { createSearchProviderSource, createWebsiteCrawlerSource, parseSearchSourceFilters, parseWebsiteFilters, type WebSourceDeps } from './web-sources.js';

/**
 * The tender sources a run may name (`sourceId`), each with everything the tenders adapter needs from it: how to create
 * it, how to turn one of its items into TenderFacts, and how to validate its filters (reporting the effective ones).
 * Every source keeps its own identity space (`TenderFacts.sourceSystem`): records of different sources are never
 * merged by identity, see docs/tenders-domain.md ("Cross-source matching").
 *
 * The web sources need a crawl engine (and a search provider); the application passes them in `deps`, the default is
 * the platform's Crawlee engine without a search provider.
 */
export interface TenderSourceDefinition {
  id: string;
  create(deps?: Partial<WebSourceDeps>): DiscoverySource<any> & { stats?(): object };
  map(item: SourceItem<any>): TenderFacts | null;
  /** Validates the run filters (throws a SourceError `invalid_filters`) and returns the effective ones for the run statistics. */
  describeFilters(filters: Record<string, unknown>): Record<string, unknown>;
}

const webDeps = (deps: Partial<WebSourceDeps> = {}): WebSourceDeps => ({ ...deps, crawler: deps.crawler ?? createDiscoveryCrawler(parseCrawlerEngine(undefined)) });

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
  [WEBSITE_SOURCE_ID]: {
    id: WEBSITE_SOURCE_ID,
    create: deps => createWebsiteCrawlerSource(webDeps(deps)),
    map: item => mapTenderPage(item.raw),
    describeFilters: filters => { const f = parseWebsiteFilters(filters); return { websiteUrl: f.url, cpvPrefixes: f.cpvPrefixes }; },
  },
  [SEARCH_SOURCE_ID]: {
    id: SEARCH_SOURCE_ID,
    create: deps => createSearchProviderSource(webDeps(deps)),
    map: item => mapTenderPage(item.raw),
    describeFilters: filters => {
      const f = parseSearchSourceFilters(filters);
      return { branch: f.branch, keywords: f.keywords, region: f.region, country: f.country, cpvPrefixes: f.cpvPrefixes };
    },
  },
};
