import type { VacancyFacts } from '../extract-vacancy.js';

/**
 * The seam every vacancy source (a website crawl, a job-board scraper, a web search) implements —
 * modeled entirely inside this domain module, never in @discovery-platform/core: only vacancies
 * knows what a "vacancy source" is, exactly like only this domain knows what a VacancyFacts is.
 * A future companies/housing/candidates module would define its own equivalent, never share this
 * one — see docs/architecture.md's note on domain modules never depending on one another.
 */
export interface VacancySourceQuery {
  /** Free-text search term — a branch name, optionally combined with the user's own keywords
   * (see buildBranchSearchQuery). Never an AI-generated synonym. */
  query: string;
  timeoutMs?: number;
  location?: string | null;
  /** How many results this source should try to return. A source may return fewer. */
  resultsWanted?: number;
  /** Only postings within the last N hours, if the source supports it. */
  hoursOld?: number | null;
  remote?: boolean | null;
}

/**
 * One candidate a source found — never a VacancyFacts on its own. `facts` holds only whatever
 * the source explicitly gave (missing fields are absent/null, never guessed); `needsEnrichment`
 * is the source's own signal that important fields (typically description or a direct contact)
 * are missing and the caller may optionally fetch `sourceUrl` through the existing crawler/
 * extractor to try to fill them in — never a requirement, never automatic.
 */
export interface VacancySourceCandidate {
  facts: Partial<VacancyFacts>;
  sourceUrl: string;
  needsEnrichment: boolean;
  /** Which origin within the provider produced this candidate (e.g. "indeed"), for per-source
   * reporting only. */
  site?: string;
}

/** Per-origin reporting — the same "ok/empty/partial/error, count, duration, reason" shape
 * ts-jobspy already reports per job board, generalized so a website crawl or a web search can
 * report themselves identically. One origin failing (e.g. LinkedIn) must never discard another
 * origin's own candidates (e.g. Indeed) — every VacancySourceProvider is expected to isolate
 * failures per origin exactly like this, not fail its entire result on one origin's error. */
export interface VacancySourceMeta {
  /** Which provider this came from, e.g. "ts-jobspy" or "brave". */
  provider: string;
  /** Which origin within that provider, e.g. "indeed", "linkedin", or the provider id itself for
   * a single-origin provider. */
  site: string;
  status: 'ok' | 'empty' | 'partial' | 'error' | 'rate_limited' | 'user_disabled' | 'not_configured' | 'unavailable' | 'not_run';
  errorType?: string;
  retryAfterMs?: number;
  attempts?: number;
  candidates: number;
  durationMs: number;
  error: string | null;
}

export interface VacancySourceResult {
  candidates: VacancySourceCandidate[];
  meta: VacancySourceMeta[];
}

export interface VacancySourceProvider {
  id: string;
  findCandidates(query: VacancySourceQuery): Promise<VacancySourceResult>;
}
