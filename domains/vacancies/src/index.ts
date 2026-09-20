// Public API of @discovery-platform/domain-vacancies. This package may import from
// @discovery-platform/core; it must never import any other domain module, React, Firebase or
// Firestore (see tests/dependency-boundary.test.mjs).
import type { DomainConfig } from '@discovery-platform/core';
import { VACANCY_LINK_TIER, vacanciesCrawlerConfig } from './config.js';
import {
  extractVacancy, extractVacancyText, normalizeVacancyFacts, extractJobPostingJsonLd,
  extractVacancyWithDiagnostic, type VacancyFacts, type VacancyPageDiagnostic,
} from './extract-vacancy.js';

export { VACANCY_LINK_TIER, vacanciesCrawlerConfig };
export { sourceFailure, summarizeSources } from './sources/outcome.js';
export { rankVacancyCandidate } from './config.js';
export { extractVacancyUrlIdentity, type VacancyUrlIdentity } from './job-identity.js';
export {
  extractVacancy, extractVacancyText, normalizeVacancyFacts, extractJobPostingJsonLd,
  extractVacancyWithDiagnostic, type VacancyFacts, type VacancyPageDiagnostic,
};
export { vacancyCompletenessScore, type VacancyCompletenessResult } from './scoring/completeness.js';
export {
  findVacancyDuplicates,
  type VacancyDuplicateDecision, type VacancyDuplicateCandidate,
} from './dedupe/matching.js';
export { VACANCY_DEDUPLICATION_CONFIG } from './dedupe/config.js';
export type { VacancyPosterFacts, VacancyVisionProvider } from './vision/poster-facts.js';
export { VACANCY_POSTER_RESPONSE_SCHEMA, VACANCY_POSTER_PROMPT, parseVacancyPosterFacts } from './vision/config.js';
export { vacancyVisionConfig, createVacancyVisionProvider } from './vision/provider.js';
export { buildBranchSearchQuery, buildJobBoardSearchTerm, removeLocationKeywords, BRANCH_SEARCH_HINTS, type BranchSearchInput } from './source-discovery.js';
export { scoreVacancyRelevance, type VacancyRelevanceQuery, type VacancyRelevanceResult } from './relevance.js';
export { isWithinPostedWindow, type PostedDateFilterOptions } from './date-filter.js';
export type {
  VacancySourceProvider, VacancySourceQuery, VacancySourceCandidate, VacancySourceMeta, VacancySourceResult,
} from './sources/types.js';
export { createTsJobSpySourceProvider, type TsJobSpySourceProviderOptions } from './sources/jobspy-source.js';
export { normalizeJobBoardLocation, resolveSearchLocation, jobBoardLocationFor, type NormalizedJobBoardLocation, type ResolvedSearchLocation } from './sources/location.js';
export {
  createVacancySourceProviderRegistry, isSearchBreadth, DEFAULT_SEARCH_BREADTH, SEARCH_BREADTH_LIMITS,
  type SearchBreadth, type SearchBreadthLimits, type VacancySourceProviderRegistration,
} from './sources/registry.js';

/**
 * A real implementation of @discovery-platform/core's DomainConfig<TFacts>. Vacancies'
 * plain-text label extraction and whitespace normalization genuinely fit DomainConfig's
 * existing `(text) => Partial<TFacts>` / `(facts) => Partial<TFacts>` shapes as-is — no change
 * to that interface was needed (see domains/vacancies/README.md for what this did and did not
 * reveal about DomainConfig).
 */
export interface VacanciesDomain extends DomainConfig<VacancyFacts> {
  id: 'vacancies';
  crawler: typeof vacanciesCrawlerConfig;
}

export const vacanciesDomain: VacanciesDomain = {
  id: 'vacancies',
  extractText: extractVacancyText,
  normalize: normalizeVacancyFacts,
  crawler: vacanciesCrawlerConfig,
};
