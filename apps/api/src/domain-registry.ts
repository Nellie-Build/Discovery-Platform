/**
 * The one place apps/api is allowed to know a domain module's name. Every route in this app
 * calls into a `DomainAdapter` looked up here — never a domain-specific import scattered
 * through routes/*.ts. Adding `companies`/`housing`/`candidates` later means writing one new
 * adapter file and adding one line here; no route changes, no database migration.
 */
import { vacanciesAdapter } from './domains/vacancies-adapter.js';
import type { DiscoveryRunConfig } from './discovery-run-config.js';

export type { DiscoveryRunConfig } from './discovery-run-config.js';
export { resolveDiscoveryRunConfig, ABSOLUTE_MAX_TARGET_RECORDS, ABSOLUTE_MAX_PAGES, ABSOLUTE_MAX_CANDIDATES, ABSOLUTE_MAX_DURATION_MS, ABSOLUTE_MAX_ENRICHMENTS } from './discovery-run-config.js';

export type DomainRegistry = Record<string, DomainAdapter>;

export interface ExistingRecordSnapshot {
  id: string;
  domainData: Record<string, unknown>;
}

export interface DiscoveredRecord {
  existingRecordId?: string;
  displayName: string | null;
  domainData: Record<string, unknown>;
  classification: Record<string, unknown>;
  score: number | null;
  sources: Array<{ sourceType: string; sourceUrl?: string | null; sourceLabel?: string | null; sourceData?: Record<string, unknown> }>;
  contacts: Array<{ type: string; value: string; normalizedValue?: string | null; confirmed?: boolean }>;
}

export interface DiscoveryRunOutcome {
  status?: 'succeeded' | 'partial' | 'failed';
  observedRecords?: DiscoveredRecord[];
  records: DiscoveredRecord[];
  stats: Record<string, unknown>;
}

/**
 * How one discovery pass should find its candidate pages: either a website to crawl (the
 * original, still fully unchanged mode), or a branch/industry to search for via a
 * `SourceSearchProvider` (see apps/api/src/domains/vacancies-adapter.ts) — a "Source Discovery"
 * layer sitting in front of the same crawler/extractor every mode ultimately shares. A domain
 * adapter that has no notion of branch search yet can simply never see the `branch` variant, since
 * apps/api only ever constructs it when a request explicitly asks for it (see routes/runs.ts).
 * `runConfig` is always present and always already resolved/clamped — every domain adapter can
 * trust its numbers outright. Module-specific filters (e.g. vacancies' own postedWithinDays/
 * sources) travel as a separate, domain-owned `filters` object apps/api never inspects.
 */
export type DiscoveryRunInput =
  | {
      mode: 'website'; sourceUrl: string; runConfig: DiscoveryRunConfig;
      /** Opaque to apps/api — passed straight through to the domain adapter. For vacancies today:
       * `{ postedWithinDays?: number }` (a website crawl has no branch/keywords/sources to
       * filter on, but a JobPosting JSON-LD page can still carry an explicit postedDate). */
      filters: Record<string, unknown>;
      existingRecords: ExistingRecordSnapshot[];
    }
  | {
      mode: 'branch'; branch: string; region: string | null; keywords: string | null;
      /** The search country ("Land"). Optional for backwards compatibility: older runs only had one
       * free-text `region`, which may itself be a country. */
      country?: string | null;
      runConfig: DiscoveryRunConfig;
      /** Opaque to apps/api — passed straight through to the domain adapter. For vacancies today:
       * `{ postedWithinDays?: number; sources?: string[] }`. */
      filters: Record<string, unknown>;
      existingRecords: ExistingRecordSnapshot[];
    };

export interface DomainAdapter {
  id: string;
  /**
   * Runs one discovery pass and returns the domain's own records, already deduplicated against
   * `existingRecords` — apps/api never re-implements dedupe itself, it only persists what the
   * adapter decided is new.
   */
  runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunOutcome>;
}

/** The registry a real deployment uses — real HTTP fetches. Tests build their own registry
 * (e.g. `{ vacancies: createVacanciesAdapter({ transport, clock }) }`) and pass it to
 * `createApp(pool, { domainRegistry })` instead of importing this constant. */
export const defaultDomainRegistry: DomainRegistry = {
  vacancies: vacanciesAdapter,
};
