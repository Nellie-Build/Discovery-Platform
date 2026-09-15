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

export interface DomainAdapter {
  id: string;
  /**
   * Runs one discovery pass against `sourceUrl` (a website, for every domain so far) and
   * returns the domain's own records, already deduplicated against `existingRecords` — apps/api
   * never re-implements dedupe itself, it only persists what the adapter decided is new.
   */
  runDiscovery(input: { sourceUrl: string; existingRecords: ExistingRecordSnapshot[] }): Promise<DiscoveryRunOutcome>;
}

/** The registry a real deployment uses — real HTTP fetches. Tests build their own registry
 * (e.g. `{ vacancies: createVacanciesAdapter({ transport, clock }) }`) and pass it to
 * `createApp(pool, { domainRegistry })` instead of importing this constant. */
export const defaultDomainRegistry: DomainRegistry = {
  vacancies: vacanciesAdapter,
};
