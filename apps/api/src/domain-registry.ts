/**
 * The one place apps/api is allowed to know a domain module's name. Every route in this app
 * calls into a `DomainAdapter` looked up here — never a domain-specific import scattered
 * through routes/*.ts. Adding `companies`/`housing`/`candidates` later means writing one new
 * adapter file and adding one line here; no route changes, no database migration.
 */
import { vacanciesAdapter } from './domains/vacancies-adapter.js';

export type DomainRegistry = Record<string, DomainAdapter>;

export interface ExistingRecordSnapshot {
  id: string;
  domainData: Record<string, unknown>;
}

export interface DiscoveredRecord {
  displayName: string | null;
  domainData: Record<string, unknown>;
  classification: Record<string, unknown>;
  score: number | null;
  sources: Array<{ sourceType: string; sourceUrl?: string | null; sourceLabel?: string | null; sourceData?: Record<string, unknown> }>;
  contacts: Array<{ type: string; value: string; normalizedValue?: string | null; confirmed?: boolean }>;
}

export interface DiscoveryRunOutcome {
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
 */
export type DiscoveryRunInput =
  | { mode: 'website'; sourceUrl: string; existingRecords: ExistingRecordSnapshot[] }
  | { mode: 'branch'; branch: string; region: string | null; keywords: string | null; existingRecords: ExistingRecordSnapshot[] };

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
