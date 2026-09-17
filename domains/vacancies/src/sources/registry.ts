import type { VacancySourceProvider } from './types.js';

/**
 * A real provider registry for the Vacancies module — replaces the two ad hoc "job board or
 * Brave" overrides `apps/api/src/domains/vacancies-adapter.ts` used to hardcode. Each provider
 * declares which search-breadth tiers include it; `apps/api` never decides this itself, it only
 * asks the registry for "the providers for this breadth" and runs whatever comes back — adding a
 * new provider later (another job board, a direct source) means registering it here, not editing
 * apps/api's own branch-discovery logic.
 */
export type SearchBreadth = 'focused' | 'standard' | 'broad';

export const DEFAULT_SEARCH_BREADTH: SearchBreadth = 'standard';

export interface VacancySourceProviderRegistration {
  id: string;
  /** Which search-breadth tiers include this provider — see SEARCH_BREADTH_LIMITS below for what
   * each tier means in practice. */
  tiers: SearchBreadth[];
  provider: VacancySourceProvider;
}

/**
 * Hard server-side maxima per breadth tier — never an unlimited crawl, regardless of how many
 * candidates a provider could theoretically return. `maxCandidatesPerProvider` bounds what a
 * single provider is asked for; `maxTotalCandidates` bounds the combined result across every
 * provider in this run; `maxEnrichments` bounds how many candidates may trigger an extra
 * fetchAndExtractPage() call; `providerTimeoutMs` bounds how long a single provider may run
 * before it is treated as its own isolated failure (see runBranchDiscovery's own per-source
 * try/catch — a timeout is reported exactly like any other provider error, never fails the run).
 */
export interface SearchBreadthLimits {
  maxCandidatesPerProvider: number;
  maxTotalCandidates: number;
  maxEnrichments: number;
  providerTimeoutMs: number;
}

export const SEARCH_BREADTH_LIMITS: Record<SearchBreadth, SearchBreadthLimits> = {
  // Reliable direct job-board providers only — no web search, tighter caps.
  focused: { maxCandidatesPerProvider: 10, maxTotalCandidates: 10, maxEnrichments: 5, providerTimeoutMs: 15_000 },
  // Job boards plus web search when configured — today's original (unchanged) default behavior.
  standard: { maxCandidatesPerProvider: 10, maxTotalCandidates: 20, maxEnrichments: 10, providerTimeoutMs: 20_000 },
  // Every active provider, wider candidate limits, more enrichment.
  broad: { maxCandidatesPerProvider: 20, maxTotalCandidates: 40, maxEnrichments: 20, providerTimeoutMs: 30_000 },
};

export function isSearchBreadth(value: unknown): value is SearchBreadth {
  return value === 'focused' || value === 'standard' || value === 'broad';
}

/** A plain, generic registry — never itself imports ts-jobspy or Brave; callers register already
 * -constructed providers (see vacancies-adapter.ts's own resolveJobBoardProvider/
 * resolveSearchProvider). */
export function createVacancySourceProviderRegistry(registrations: VacancySourceProviderRegistration[]) {
  return {
    /** Every registered provider that participates in the given breadth tier, in registration
     * order. */
    providersFor(breadth: SearchBreadth): VacancySourceProviderRegistration[] {
      return registrations.filter(registration => registration.tiers.includes(breadth));
    },
  };
}
