/**
 * The vacancies DomainAdapter — the only file in apps/api allowed to import
 * @discovery-platform/domain-vacancies. Composes discovery-core's crawler with the domain
 * module's own extraction, completeness scoring and dedupe — apps/api itself never parses a
 * vacancy field.
 *
 * Two discovery modes share everything downstream of "a list of freshly extracted VacancyFacts":
 *   - website: the original, unchanged mode — discovery-core's `crawlWebsite()` crawls one site.
 *   - branch: a "Source Discovery" layer sits in front of the same crawler/extractor — a branch/
 *     region/keyword search (see domains/vacancies's own `buildBranchSearchQuery`) is turned into
 *     candidate URLs by a `SourceSearchProvider` (Brave Search, by default), normalized/deduped,
 *     capped at a conservative maximum, and each candidate is fetched as a single page (never a
 *     full multi-page site crawl per candidate — crawlWebsite() always restarts from a site's own
 *     homepage, the wrong behavior for a specific search-result deep link) via discovery-core's
 *     `fetchAndExtractPage()`. A search result is only ever a *candidate* — every candidate page
 *     still goes through the exact same `extractVacancy()` (JobPosting JSON-LD, microdata, label/
 *     value DOM patterns, and the plausibility check) as a normal website crawl; nothing from a
 *     search snippet is ever stored as a record on its own.
 */
import {
  crawlWebsite, fetchAndExtractPage, normalizeCandidateUrls, createBraveSearchProvider,
  type CrawlOptions, type SourceSearchProvider,
} from '@discovery-platform/core';
import {
  extractVacancy, vacanciesCrawlerConfig, vacancyCompletenessScore, findVacancyDuplicates, buildBranchSearchQuery,
  type VacancyFacts,
} from '@discovery-platform/domain-vacancies';
import type { DomainAdapter, ExistingRecordSnapshot, DiscoveryRunInput, DiscoveryRunOutcome } from '../domain-registry.js';

/** Only the crawler internals a test ever legitimately needs to override (see
 * domains/vacancies's own tests for the same `transport`/`clock` injection pattern) — never
 * exposed through the HTTP API itself, only through `createVacanciesAdapter()` directly.
 * `searchProvider` is the same idea for branch mode: a test injects a fake `SourceSearchProvider`
 * instead of hitting the real Brave Search API — see apps/api/tests/branch-discovery.test.mjs. */
export type VacanciesCrawlOverrides = Pick<CrawlOptions<VacancyFacts>, 'transport' | 'clock'> & {
  searchProvider?: SourceSearchProvider;
};

// A conservative cap for this test phase — protects against an uncontrolled number of candidate
// page fetches (and, once a real key is configured, uncontrolled Brave Search API cost).
const MAX_BRANCH_CANDIDATES = 10;
const BRANCH_SEARCH_COUNTRY = 'NL';
const BRANCH_SEARCH_LANGUAGE = 'nl';

// Deliberately simple and country-agnostic, exactly like examples/vacancy-discovery's own —
// domains/vacancies owns no phone-numbering-plan knowledge of its own, so a caller always
// supplies normalizers.
const contactNormalizers = {
  normalizePhone(raw: string): string | null {
    const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    // A number that already spells out its own country code (a leading `+`) is normalized as
    // international. A local number with no `+` stays local — we never invent a country code
    // (e.g. `0654764363` must never become `+0654764363` or `+31654764363`).
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{8,15}$/.test(digits)) return digits;
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
 * another *within this one run's own results* into a single survivor (the more complete fact),
 * using union-find over the candidate pairs. `possible_duplicate` pairs are left as separate
 * records — this phase only auto-merges the engine's strongest signal. */
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

/** Shared by both modes: collapse within-run duplicates, drop anything already persisted for
 * this project, score what survives, and shape it into the generic DiscoveredRecord[] apps/api
 * persists — website mode and branch mode differ only in *how* `freshFacts` was gathered. */
function buildRecordsFromFacts(freshFacts: VacancyFacts[], existingRecords: ExistingRecordSnapshot[]) {
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
  return { records, collapsed, duplicatesAgainstExisting };
}

function resolveSearchProvider(overrides: VacanciesCrawlOverrides): SourceSearchProvider | undefined {
  if (overrides.searchProvider) return overrides.searchProvider;
  // Read lazily (never at module load) so a missing key is detected at the moment a branch
  // search is actually requested, exactly like createGeminiVisionProvider's own apiKey check —
  // website mode never touches this and is completely unaffected either way.
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  return apiKey ? createBraveSearchProvider(apiKey) : undefined;
}

async function runWebsiteDiscovery(
  input: Extract<DiscoveryRunInput, { mode: 'website' }>,
  overrides: VacanciesCrawlOverrides,
): Promise<DiscoveryRunOutcome> {
  const crawl = await crawlWebsite(input.sourceUrl, {
    extract: extractVacancy,
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
    contactNormalizers,
    transport: overrides.transport,
    clock: overrides.clock,
  });
  const freshFacts = crawl.extractedPages.map(page => page.data);
  const { records, collapsed, duplicatesAgainstExisting } = buildRecordsFromFacts(freshFacts, input.existingRecords);
  return {
    records,
    stats: {
      searchMode: 'website',
      crawlStatus: crawl.status,
      pagesVisited: crawl.pagesVisited,
      factsFound: freshFacts.length,
      duplicatesWithinCrawl: collapsed,
      duplicatesAgainstExisting,
      recordsCreated: records.length,
    },
  };
}

/**
 * Source Discovery for vacancies: branch query -> web search provider -> candidate URLs ->
 * normalize/dedupe -> the existing vacancy crawler/extractor (one page at a time, never a full
 * site crawl per candidate) -> the existing plausibility filtering (inside extractVacancy itself)
 * -> the exact same scoring/dedupe website mode already uses.
 */
async function runBranchDiscovery(
  input: Extract<DiscoveryRunInput, { mode: 'branch' }>,
  overrides: VacanciesCrawlOverrides,
): Promise<DiscoveryRunOutcome> {
  const searchQuery = buildBranchSearchQuery({ branch: input.branch, region: input.region, keywords: input.keywords });
  const searchProvider = resolveSearchProvider(overrides);
  if (!searchProvider) {
    // A clear, safe message — never the raw search-provider error, never a key, and this never
    // crashes the process: it is caught by routes/runs.ts exactly like any other adapter failure
    // and surfaces as this run's own `error`, with website mode entirely unaffected.
    throw new Error('Zoeken op branche is nog niet geconfigureerd: BRAVE_SEARCH_API_KEY ontbreekt. Neem contact op met de beheerder.');
  }

  const rawCandidates = await searchProvider.search({
    query: searchQuery, country: BRANCH_SEARCH_COUNTRY, language: BRANCH_SEARCH_LANGUAGE, count: MAX_BRANCH_CANDIDATES,
  });
  const candidates = normalizeCandidateUrls(rawCandidates, { maxCandidates: MAX_BRANCH_CANDIDATES });

  const freshFacts: VacancyFacts[] = [];
  let candidatesCrawled = 0;
  for (const candidate of candidates) {
    const result = await fetchAndExtractPage(candidate.url, {
      extract: extractVacancy,
      contactNormalizers,
      linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
      transport: overrides.transport,
    });
    if (result.status !== 'succeeded') continue;
    candidatesCrawled++;
    if (result.data) freshFacts.push(...result.data);
  }

  const { records, collapsed, duplicatesAgainstExisting } = buildRecordsFromFacts(freshFacts, input.existingRecords);
  return {
    records,
    stats: {
      searchMode: 'branch',
      searchQuery,
      branch: input.branch,
      region: input.region,
      keywords: input.keywords,
      candidatesFound: candidates.length,
      candidatesCrawled,
      pagesVisited: candidatesCrawled,
      factsFound: freshFacts.length,
      duplicatesWithinCrawl: collapsed,
      duplicatesAgainstExisting,
      recordsCreated: records.length,
    },
  };
}

export function createVacanciesAdapter(crawlOverrides: VacanciesCrawlOverrides = {}): DomainAdapter {
  return {
    id: 'vacancies',
    async runDiscovery(input: DiscoveryRunInput) {
      return input.mode === 'branch' ? runBranchDiscovery(input, crawlOverrides) : runWebsiteDiscovery(input, crawlOverrides);
    },
  };
}

/** The production adapter — real HTTP fetches, real clock, and (once BRAVE_SEARCH_API_KEY is
 * configured) a real Brave Search provider for branch mode. Tests should call
 * `createVacanciesAdapter({ transport, clock, searchProvider })` directly instead, exactly like
 * domains/vacancies's own crawler tests inject a fake transport rather than hitting the network. */
export const vacanciesAdapter: DomainAdapter = createVacanciesAdapter();
