/**
 * The one place apps/api is allowed to know a domain module's name. Every route in this app
 * calls into a `DomainAdapter` looked up here — never a domain-specific import scattered
 * through routes/*.ts. Adding `companies`/`housing`/`candidates` later means writing one new
 * adapter file and adding one line here; no route changes, no database migration.
 */
import { vacanciesAdapter } from './domains/vacancies-adapter.js';
import { tendersAdapter } from './domains/tenders-adapter.js';
import { companiesAdapter } from './domains/companies-adapter.js';
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
  /** A short, user-facing reason, stored on the run when `status` is `failed`. */
  error?: string;
  observedRecords?: DiscoveredRecord[];
  /** Existing records (`existingRecordId` set) that a later run found newer information about: their stored facts are replaced with `domainData`, and any `sources` they did not have are added. Never counts as a created record. */
  updatedRecords?: DiscoveredRecord[];
  records: DiscoveredRecord[];
  stats: Record<string, unknown>;
  /**
   * Work this run left for a follow-up batch (e.g. candidates not researched within the budget): an opaque cursor the
   * adapter understands, kept by the server with the run (stats.continuation) and handed back on
   * `{ continueFromRunId }`. Null or absent: nothing left.
   */
  continuation?: { cursor: string; remaining: number } | null;
}

/** A follow-up batch of an earlier run: the cursor that run left (read from the database, never from the client). */
export interface RunContinuation { fromRunId: string; cursor: string }

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
export type DiscoveryRunInput = ({ continuation?: RunContinuation }) & (
  | {
      /** Pull from a named DiscoverySource (an API or feed) instead of crawling: no website, no branch. `filters` are the source's own. */
      mode: 'source'; sourceId: string; runConfig: DiscoveryRunConfig;
      filters: Record<string, unknown>;
      existingRecords: ExistingRecordSnapshot[];
    }
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
    });

export interface DomainAdapter {
  id: string;
  /**
   * Runs one discovery pass and returns the domain's own records, already deduplicated against
   * `existingRecords` — apps/api never re-implements dedupe itself, it only persists what the
   * adapter decided is new.
   */
  runDiscovery(input: DiscoveryRunInput): Promise<DiscoveryRunOutcome>;
  /**
   * Extended processing (background jobs, jobs/job-runner.ts): only an adapter that can continue a search in batches
   * without searching again declares this. `validateRequest` checks a job's request up front and returns a user-facing
   * reason when it cannot run as a job (null when it can), so a user never waits for a batch that is bound to fail.
   */
  backgroundJobs?: { validateRequest(input: DiscoveryRunInput): string | null };
  /**
   * CSV export of a project's records (routes/records.ts): the domain decides the columns and leaves out personal data;
   * apps/api only checks access and the row limit and serves the file.
   */
  exportCsv?: { maxRows: number; build(records: Array<{ id: string; displayName: string | null; domainData: Record<string, unknown> }>): { csv: string; filename: string } };
}

/** The registry a real deployment uses — real HTTP fetches. Tests build their own registry
 * (e.g. `{ vacancies: createVacanciesAdapter({ transport, clock }) }`) and pass it to
 * `createApp(pool, { domainRegistry })` instead of importing this constant. */
export const defaultDomainRegistry: DomainRegistry = {
  vacancies: vacanciesAdapter,
  tenders: tendersAdapter,
  companies: companiesAdapter,
};
