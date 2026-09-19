// Public API of @discovery-platform/core. External consumers should only ever need these
// named exports — never a deep import into src/crawler/* or src/extract/* — so that this
// package's internal file layout can change freely without breaking anyone who depends on it.
// This package must never import any specific product's application code, database schema, or
// any specific domain module — see tests/dependency-boundary.test.mjs for the automated check,
// fixtures/standalone-bootstrap/verify.mjs for a mechanical proof this package builds/tests
// completely on its own, and docs/architecture.md at the repository root for the wider
// Source -> Core -> Domain Module -> Structured Record -> Workflow architecture.

export { fetchPublicUrl, isPublicAddress, type HttpResult, type HttpTransport } from './crawler/http.js';
export { websiteScope, linkPriority, type PriorityTier } from './crawler/url-policy.js';
export { CandidateQueue, type CandidateEvidence, type CandidateRank, type CrawlCandidate } from './crawler/candidate-ranking.js';
export {
  crawlWebsite, CRAWL_POLICY,
  type CrawlOptions, type CrawlPage,
} from './crawler/website-crawler.js';
export type { CrawlRecord, CrawlResult, CrawlStatus, CrawlStopReason, ExtractedPage } from './crawler/types.js';
export {
  fetchAndExtractPage,
  type SinglePageFetchOptions, type SinglePageFetchResult,
} from './crawler/single-page.js';
export {
  extractContacts, extractWhatsApp, extractWhatsAppText, mergeContacts, EMPTY_CONTACTS,
  type ExtractedContacts, type ContactNormalizers,
} from './extract/contacts.js';
export type { DomainConfig } from './domain-config.js';
export {
  runScoring,
  type ScoringRule, type ScoringContribution, type ScoringOptions, type ScoringResult,
} from './scoring/engine.js';
export {
  scoreMatch, haversineDistanceMeters, findDuplicateCandidates,
  type DedupeDecision, type DedupeSignalMatch, type DedupeThresholds, type ScoreMatchOptions, type DedupeResult,
  type ExactKeySignal, type DistanceSignal, type DedupeCandidate, type FindDuplicateCandidatesOptions,
} from './dedupe/engine.js';
export {
  createGeminiVisionProvider, VISION_SAFETY_INSTRUCTIONS,
  type VisionProvider, type VisionAnalysisConfig, type GeminiVisionProviderOptions,
} from './vision/provider.js';
export {
  createBraveSearchProvider,
  type SourceSearchProvider, type SourceSearchInput, type SearchCandidate, type BraveSearchProviderOptions,
} from './search/provider.js';
export {
  normalizeCandidateUrls,
  type NormalizeCandidatesOptions,
} from './search/candidates.js';
