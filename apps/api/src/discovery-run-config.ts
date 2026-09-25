/**
 * How much a Discovery Run should try to do — user-configurable, always server-validated (see
 * `resolveDiscoveryRunConfig` below; the frontend is never the security boundary). Deliberately
 * generic: nothing here is vacancy-specific — a module-specific filter set (e.g. the vacancies
 * module's own branch/keywords/postedWithinDays/sources) travels alongside this, never inside it.
 *
 * Lives in its own file, separate from domain-registry.ts, so that a domain adapter (e.g.
 * vacancies-adapter.ts) can import `resolveDiscoveryRunConfig` for its own defensive fallback
 * without creating an import cycle with domain-registry.ts, which itself imports the adapter.
 */
export interface DiscoveryRunConfig {
  /** How many *accepted, deduplicated* records a run should try to find — never a candidate or
   * page count. A run stops once it has this many, or another stop condition is reached first. */
  targetRecords: number;
  budgetSource: 'adaptive' | 'advanced';
  /** A domain-defined tier id ("focused" | "standard" | "broad" | "advanced" for vacancies today)
   * — apps/api never hardcodes what a tier means; an unrecognized value is the domain's own
   * business to fall back on sensibly. */
  searchBreadth: string;
  maxPages: number;
  maxCandidates: number;
  maxDurationMs: number;
  maxEnrichments: number;
  /** When true (the default), a candidate that duplicates a record already persisted for this
   * project is always skipped, exactly like every run before this option existed. When false, a
   * matching existing record no longer disqualifies a fresh candidate — still deduplicated
   * *within* the run itself either way, this only affects matching against records from earlier
   * runs (e.g. deliberately re-discovering a vacancy to track whether it is still posted). */
  onlyNewRecords: boolean;
}

/** Hard, server-side ceilings — no field of `DiscoveryRunConfig` a client sends is ever trusted
 * past these, regardless of what the frontend itself allows a user to type (see
 * `resolveDiscoveryRunConfig`). Chosen against this deployment's own Cloud Run architecture: no
 * request timeout is configured for the web service (see .github/workflows/deploy.yml), so Cloud
 * Run's own default of 300s applies — `ABSOLUTE_MAX_DURATION_MS` stays safely under that with
 * margin for the DB write/response itself. There is deliberately no "unlimited" option anywhere. */
export const ABSOLUTE_MAX_TARGET_RECORDS = 1000;
export const ABSOLUTE_MAX_PAGES = 200;
export const ABSOLUTE_MAX_CANDIDATES = 500;
export const ABSOLUTE_MAX_DURATION_MS = 240_000;
export const ABSOLUTE_MAX_ENRICHMENTS = 150;

const DEFAULT_RUN_CONFIG = {
  targetRecords: 50, searchBreadth: 'standard', maxEnrichments: 30, onlyNewRecords: true,
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The one place a client-supplied run config is ever trusted — every field is clamped to its own
 * absolute ceiling above, and an invalid/missing field silently falls back to a sensible default
 * rather than rejecting the whole request. Never skipped: routes/runs.ts calls this on every run,
 * whether or not the client sent a `runConfig` at all. */
export function resolveDiscoveryRunConfig(input: Partial<DiscoveryRunConfig> | null | undefined, module = 'vacancies'): DiscoveryRunConfig {
  const raw = input ?? {};
  const targetRecords = clampNumber(raw.targetRecords, DEFAULT_RUN_CONFIG.targetRecords, 1, ABSOLUTE_MAX_TARGET_RECORDS);
  const searchBreadth = typeof raw.searchBreadth === 'string' && raw.searchBreadth.trim() ? raw.searchBreadth.trim() : DEFAULT_RUN_CONFIG.searchBreadth;
  const breadth = searchBreadth === 'focused' ? 0.75 : searchBreadth === 'broad' ? 1.5 : 1;
  // Companies: every result means reading a company's own site (several pages), so more time per wanted record.
  const effort = targetRecords * breadth * (module === 'vacancies' ? 2.5 : module === 'companies' ? 6 : 2);
  const advanced = [raw.maxPages, raw.maxCandidates, raw.maxDurationMs, raw.maxEnrichments]
    .some(value => typeof value === 'number' && Number.isFinite(value));
  return {
    targetRecords, searchBreadth, budgetSource: advanced ? 'advanced' : 'adaptive',
    maxPages: clampNumber(raw.maxPages, Math.ceil(5 + effort), 1, ABSOLUTE_MAX_PAGES),
    maxCandidates: clampNumber(raw.maxCandidates, Math.ceil(20 + effort * 4), 1, ABSOLUTE_MAX_CANDIDATES),
    maxDurationMs: clampNumber(raw.maxDurationMs, Math.ceil(30_000 + effort * 2000), 1_000, ABSOLUTE_MAX_DURATION_MS),
    maxEnrichments: clampNumber(raw.maxEnrichments, DEFAULT_RUN_CONFIG.maxEnrichments, 0, ABSOLUTE_MAX_ENRICHMENTS),
    onlyNewRecords: typeof raw.onlyNewRecords === 'boolean' ? raw.onlyNewRecords : DEFAULT_RUN_CONFIG.onlyNewRecords,
  };
}
