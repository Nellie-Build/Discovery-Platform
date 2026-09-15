/**
 * The vacancies DomainAdapter — the only file in apps/api allowed to import
 * @discovery-platform/domain-vacancies. Composes discovery-core's crawler with the domain
 * module's own extraction, completeness scoring and dedupe — apps/api itself never parses a
 * vacancy field.
 */
import { crawlWebsite, type CrawlOptions } from '@discovery-platform/core';
import {
  extractVacancy, vacanciesCrawlerConfig, vacancyCompletenessScore, findVacancyDuplicates,
  type VacancyFacts,
} from '@discovery-platform/domain-vacancies';
import type { DomainAdapter, ExistingRecordSnapshot } from '../domain-registry.js';

/** Only the crawler internals a test ever legitimately needs to override (see
 * domains/vacancies's own tests for the same `transport`/`clock` injection pattern) — never
 * exposed through the HTTP API itself, only through `createVacanciesAdapter()` directly. */
export type VacanciesCrawlOverrides = Pick<CrawlOptions<VacancyFacts>, 'transport' | 'clock'>;

// Deliberately simple and country-agnostic, exactly like examples/vacancy-discovery's own —
// domains/vacancies owns no phone-numbering-plan knowledge of its own, so a caller always
// supplies normalizers.
const contactNormalizers = {
  normalizePhone(raw: string): string | null {
    const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{8,15}$/.test(digits)) return '+' + digits;
    return null;
  },
  normalizeEmail(raw: string): string | null {
    const email = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
  },
};

function completenessOf(fact: VacancyFacts): number {
  return vacancyCompletenessScore(fact).score;
}

/** Collapses vacancies that findVacancyDuplicates flags as an outright `duplicate` of one
 * another *within this one crawl's own results* into a single survivor (the more complete
 * fact), using union-find over the candidate pairs. `possible_duplicate` pairs are left as
 * separate records — this phase only auto-merges the engine's strongest signal. */
function collapseDuplicatesWithinCrawl(facts: VacancyFacts[]): { survivors: VacancyFacts[]; collapsed: number } {
  const parent = facts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const indexOf = new Map(facts.map((fact, i) => [fact, i]));
  for (const candidate of findVacancyDuplicates(facts)) {
    if (candidate.decision !== 'duplicate') continue;
    union(indexOf.get(candidate.vacancyA)!, indexOf.get(candidate.vacancyB)!);
  }

  const groups = new Map<number, VacancyFacts[]>();
  facts.forEach((fact, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(fact); else groups.set(root, [fact]);
  });
  const survivors = [...groups.values()].map(group => group.reduce((best, fact) => (completenessOf(fact) > completenessOf(best) ? fact : best)));
  return { survivors, collapsed: facts.length - survivors.length };
}

/** True when `fact` is a duplicate (per the vacancies domain's own rules) of any record already
 * persisted for this project. apps/api never re-implements this check itself — it only asks the
 * domain module, passing the existing records' own domain_data back through it unchanged. */
function isDuplicateOfExisting(fact: VacancyFacts, existingFacts: VacancyFacts[]): boolean {
  if (existingFacts.length === 0) return false;
  const candidates = findVacancyDuplicates([...existingFacts, fact]);
  return candidates.some(c => c.decision !== 'none' && (c.vacancyA === fact || c.vacancyB === fact));
}

function buildContacts(fact: VacancyFacts) {
  const contacts: Array<{ type: string; value: string }> = [];
  if (fact.phone) contacts.push({ type: 'phone', value: fact.phone });
  if (fact.email) contacts.push({ type: 'email', value: fact.email });
  if (fact.contactPerson) contacts.push({ type: 'contact_person', value: fact.contactPerson });
  return contacts;
}

export function createVacanciesAdapter(crawlOverrides: VacanciesCrawlOverrides = {}): DomainAdapter {
  return {
    id: 'vacancies',

    async runDiscovery({ sourceUrl, existingRecords }: { sourceUrl: string; existingRecords: ExistingRecordSnapshot[] }) {
      const crawl = await crawlWebsite(sourceUrl, {
        extract: extractVacancy,
        linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
        contactNormalizers,
        ...crawlOverrides,
      });
      const freshFacts = crawl.extractedPages.map(page => page.data);
      const { survivors, collapsed } = collapseDuplicatesWithinCrawl(freshFacts);

      const existingFacts = existingRecords.map(record => record.domainData as unknown as VacancyFacts);
      let duplicatesAgainstExisting = 0;
      const records = [];
      for (const fact of survivors) {
        if (isDuplicateOfExisting(fact, existingFacts)) { duplicatesAgainstExisting++; continue; }
        const completeness = vacancyCompletenessScore(fact);
        records.push({
          displayName: fact.title ?? fact.company ?? null,
          domainData: fact as unknown as Record<string, unknown>,
          classification: { presentSignals: completeness.presentSignals, missingSignals: completeness.missingSignals },
          score: completeness.score,
          sources: [{ sourceType: 'website', sourceUrl: fact.sourceUrl, sourceLabel: null, sourceData: {} }],
          contacts: buildContacts(fact),
        });
      }

      return {
        records,
        stats: {
          crawlStatus: crawl.status,
          pagesVisited: crawl.pagesVisited,
          factsFound: freshFacts.length,
          duplicatesWithinCrawl: collapsed,
          duplicatesAgainstExisting,
          recordsCreated: records.length,
        },
      };
    },
  };
}

/** The production adapter — real HTTP fetches, real clock. Tests should call
 * `createVacanciesAdapter({ transport, clock })` directly instead, exactly like
 * domains/vacancies's own crawler tests inject a fake transport rather than hitting the network. */
export const vacanciesAdapter: DomainAdapter = createVacanciesAdapter();
