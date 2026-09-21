// Public API of @discovery-platform/domain-tenders. This package may import from
// @discovery-platform/core; it must never import any other domain module, an application, React or
// a database (see tests/dependency-boundary.test.mjs).
export type { TenderFacts, TenderPublication, CpvCode, NutsCode } from './tender-facts.js';
export {
  createTenderNedSource, parseTenderNedFilters, TENDERNED_SOURCE_ID, TENDERNED_BASE_URL, MAX_RANGE_DAYS, DEFAULT_RANGE_DAYS,
  type TenderNedSource, type TenderNedSourceOptions, type TenderNedSourceStats, type TenderNedFilters, type TenderNedRaw,
} from './tenderned-source.js';
export { mapTenderNedPublication, mergeTenderPublications } from './tenderned-map.js';
export {
  createTedSource, parseTedFilters, buildTedQuery, TED_SOURCE_ID, TED_SEARCH_URL, TED_FIELDS, TED_MAX_RESULT_WINDOW,
  type TedSource, type TedSourceOptions, type TedSourceStats, type TedFilters, type TedNoticeRaw,
} from './ted-source.js';
export { mapTedNotice, pickLanguage } from './ted-map.js';
export { TENDER_SOURCES, type TenderSourceDefinition } from './sources.js';
export { storedTenderFacts, updateStoredTender, tenderFactsEqual, type TenderUpdate } from './update.js';
export { tenderIdentityKey, storedTenderIdentityKey, tenderCompletenessScore } from './identity.js';
