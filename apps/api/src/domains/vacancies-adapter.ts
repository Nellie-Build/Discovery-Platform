/**
 * The vacancies DomainAdapter — the only file in apps/api allowed to import
 * @discovery-platform/domain-vacancies. Composes discovery-core's crawler with the domain
 * module's own extraction, completeness scoring and dedupe — apps/api itself never parses a
 * vacancy field. It also never imports ts-jobspy, or knows Indeed/LinkedIn/job-board vocabulary
 * exists — that dependency lives entirely inside domains/vacancies (see its own
 * src/sources/jobspy-source.ts); this file only ever sees the domain's own
 * VacancySourceProvider/VacancySourceCandidate/VacancySourceMeta types (see
 * tests/dependency-boundary.test.mjs's own automated check for this).
 *
 * Two discovery modes share everything downstream of "a list of freshly extracted VacancyFacts":
 *   - website: the original, unchanged mode — discovery-core's `crawlWebsite()` crawls one site.
 *   - branch: a "Source Discovery" layer sits in front of the same downstream pipeline. Two
 *     sources both contribute candidates for the same branch/region/keyword query:
 *       - the job-board provider (ts-jobspy: Indeed + LinkedIn today) — always attempted, no API
 *         key required. It already returns structured VacancyFacts directly; a candidate is only
 *         re-crawled through fetchAndExtractPage()/extractVacancy() when the job board itself
 *         left important fields (description, any direct contact) empty — optional enrichment,
 *         never a default re-crawl of already-structured data.
 *       - a `SourceSearchProvider` (Brave Search) — entirely optional; with no
 *         BRAVE_SEARCH_API_KEY configured it simply contributes nothing, it never fails the run.
 *         Brave candidates are bare URLs (a snippet is never a fact), so every one of them goes
 *         through the full fetchAndExtractPage()/extractVacancy() flow, exactly as before.
 *     Either source failing is isolated and reported in `stats.sources`; it never discards the
 *     other source's own candidates. Everything downstream (plausibility, in extractVacancy
 *     itself; scoring; dedupe) is the exact same pipeline website mode already uses.
 */
import {
  crawlWebsite, fetchAndExtractPage, normalizeCandidateUrls, createBraveSearchProvider,
  type CrawlOptions, type SourceSearchProvider,
} from '@discovery-platform/core';
import {
  extractVacancy, vacanciesCrawlerConfig, vacancyCompletenessScore, findVacancyDuplicates,
  buildBranchSearchQuery, buildJobBoardSearchTerm, createTsJobSpySourceProvider,
  type VacancyFacts, type VacancySourceProvider, type VacancySourceCandidate, type VacancySourceMeta,
} from '@discovery-platform/domain-vacancies';
import type { DomainAdapter, ExistingRecordSnapshot, DiscoveryRunInput, DiscoveryRunOutcome } from '../domain-registry.js';

/** Only the crawler internals a test ever legitimately needs to override (see
 * domains/vacancies's own tests for the same `transport`/`clock` injection pattern) — never
 * exposed through the HTTP API itself, only through `createVacanciesAdapter()` directly.
 * `searchProvider` (Brave) and `jobBoardProvider` (ts-jobspy, via the domain's own factory) are
 * the same idea for branch mode: a test injects a fake provider instead of hitting a real
 * external API — see apps/api/tests/vacancies-adapter-branch.test.mjs. */
export type VacanciesCrawlOverrides = Pick<CrawlOptions<VacancyFacts>, 'transport' | 'clock'> & {
  searchProvider?: SourceSearchProvider;
  jobBoardProvider?: VacancySourceProvider;
};

// Conservative caps for this phase — protect against an uncontrolled number of candidate page
// fetches/API cost. jobsWanted is *per site* (ts-jobspy's own convention), not a total.
const MAX_BRANCH_CANDIDATES = 10;
const JOB_BOARD_RESULTS_WANTED_PER_SITE = 10;
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
 * records — this phase only auto-merges the engine's strongest signal. The same vacancy found
 * via both the job board and a website/Brave candidate collapses here too — one set of facts,
 * one record, regardless of how many sources agreed on it. */
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
 * persists — website mode and branch mode (and, within branch mode, each of its sources) differ
 * only in *how* `freshFacts` was gathered. */
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

/** apps/api never constructs a ts-jobspy option object or sees a ts-jobspy Job — this just asks
 * the domain module for its own default provider (real ts-jobspy in production) unless a test
 * already injected a fake one. */
function resolveJobBoardProvider(overrides: VacanciesCrawlOverrides): VacancySourceProvider {
  return overrides.jobBoardProvider ?? createTsJobSpySourceProvider({ resultsWanted: JOB_BOARD_RESULTS_WANTED_PER_SITE });
}

function fillMissing(primary: Partial<VacancyFacts>, secondary: Partial<VacancyFacts> | undefined, sourceUrl: string): VacancyFacts {
  const s = secondary ?? {};
  return {
    title: primary.title ?? s.title ?? null,
    company: primary.company ?? s.company ?? null,
    location: primary.location ?? s.location ?? null,
    salary: primary.salary ?? s.salary ?? null,
    hours: primary.hours ?? s.hours ?? null,
    contractType: primary.contractType ?? s.contractType ?? null,
    description: primary.description ?? s.description ?? null,
    contactPerson: primary.contactPerson ?? s.contactPerson ?? null,
    phone: primary.phone ?? s.phone ?? null,
    email: primary.email ?? s.email ?? null,
    sourceUrl,
  };
}

/** A job-board candidate that already has structured data is never re-crawled by default — only
 * when the provider itself flagged `needsEnrichment` (important fields genuinely missing) do we
 * fetch its own URL once through the exact same fetchAndExtractPage()/extractVacancy() flow a
 * website crawl uses, then fill in only the fields the job board left null. The job board's own
 * fields always win over anything enrichment finds. */
async function completeJobBoardCandidate(candidate: VacancySourceCandidate, overrides: VacanciesCrawlOverrides): Promise<VacancyFacts> {
  if (!candidate.needsEnrichment) return fillMissing(candidate.facts, undefined, candidate.sourceUrl);
  const enrichment = await fetchAndExtractPage(candidate.sourceUrl, {
    extract: extractVacancy,
    contactNormalizers,
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
    transport: overrides.transport,
  });
  const enrichedFacts = enrichment.status === 'succeeded' ? enrichment.data?.[0] : undefined;
  return fillMissing(candidate.facts, enrichedFacts, candidate.sourceUrl);
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
 * Source Discovery for vacancies: branch query -> (job-board provider + optional web-search
 * provider) -> candidates -> normalize/dedupe -> the existing vacancy crawler/extractor for
 * enrichment only where needed -> the existing plausibility filtering (inside extractVacancy
 * itself) -> the exact same scoring/dedupe website mode already uses. Either source failing is
 * isolated: it is reported in `stats.sources` and never discards the other source's candidates.
 */
async function runBranchDiscovery(
  input: Extract<DiscoveryRunInput, { mode: 'branch' }>,
  overrides: VacanciesCrawlOverrides,
): Promise<DiscoveryRunOutcome> {
  // Two distinct queries, never one string reused for both: a web-search engine (Brave) gets the
  // generic "vacature vacatures jobs" discovery hints plus region folded into the query text (it
  // has no separate location parameter); a job board (ts-jobspy) gets only the user's own branch
  // + keywords, verbatim — no hints, no region (region goes through its own dedicated location/
  // country parameters instead — see sources/location.ts). Neither ever rewords/translates the
  // user's branch ("Beveiliging" must never silently become "Security").
  const webSearchQuery = buildBranchSearchQuery({ branch: input.branch, region: input.region, keywords: input.keywords });
  const jobBoardSearchTerm = buildJobBoardSearchTerm({ branch: input.branch, keywords: input.keywords });
  const sources: VacancySourceMeta[] = [];
  const freshFacts: VacancyFacts[] = [];
  let candidatesFound = 0;
  let candidatesCrawled = 0;

  // The job board (ts-jobspy: Indeed + LinkedIn) — always attempted, no API key required. This
  // is branch mode's primary source; a failure here is isolated and never prevents Brave (below)
  // from still contributing.
  try {
    const jobBoard = resolveJobBoardProvider(overrides);
    const jobBoardResult = await jobBoard.findCandidates({ query: jobBoardSearchTerm, location: input.region, resultsWanted: JOB_BOARD_RESULTS_WANTED_PER_SITE });
    sources.push(...jobBoardResult.meta);
    candidatesFound += jobBoardResult.candidates.length;
    for (const candidate of jobBoardResult.candidates) {
      freshFacts.push(await completeJobBoardCandidate(candidate, overrides));
      candidatesCrawled++;
    }
  } catch (error) {
    sources.push({ provider: 'ts-jobspy', site: 'ts-jobspy', status: 'error', candidates: 0, durationMs: 0, error: error instanceof Error ? error.message : String(error) });
  }

  // Brave web search — entirely optional. No key configured means no attempt at all: it simply
  // contributes nothing, never a run failure (see resolveSearchProvider's own doc comment).
  const searchProvider = resolveSearchProvider(overrides);
  if (searchProvider) {
    const start = Date.now();
    try {
      const rawCandidates = await searchProvider.search({
        query: webSearchQuery, country: BRANCH_SEARCH_COUNTRY, language: BRANCH_SEARCH_LANGUAGE, count: MAX_BRANCH_CANDIDATES,
      });
      const candidates = normalizeCandidateUrls(rawCandidates, { maxCandidates: MAX_BRANCH_CANDIDATES });
      candidatesFound += candidates.length;
      let braveCrawled = 0;
      for (const candidate of candidates) {
        const result = await fetchAndExtractPage(candidate.url, {
          extract: extractVacancy,
          contactNormalizers,
          linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
          transport: overrides.transport,
        });
        if (result.status !== 'succeeded') continue;
        braveCrawled++;
        candidatesCrawled++;
        if (result.data) freshFacts.push(...result.data);
      }
      sources.push({
        provider: 'brave', site: 'brave', status: candidates.length === 0 ? 'empty' : 'ok',
        candidates: braveCrawled, durationMs: Date.now() - start, error: null,
      });
    } catch (error) {
      sources.push({ provider: 'brave', site: 'brave', status: 'error', candidates: 0, durationMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const { records, collapsed, duplicatesAgainstExisting } = buildRecordsFromFacts(freshFacts, input.existingRecords);
  return {
    records,
    stats: {
      searchMode: 'branch',
      searchQuery: webSearchQuery,
      jobBoardSearchTerm,
      branch: input.branch,
      region: input.region,
      keywords: input.keywords,
      sources,
      candidatesFound,
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

/** The production adapter — real HTTP fetches, real clock, the real ts-jobspy-backed job-board
 * provider (via the domain module's own factory — this file never touches ts-jobspy itself),
 * and (once BRAVE_SEARCH_API_KEY is configured) a real Brave Search provider for branch mode.
 * Tests should call `createVacanciesAdapter({ transport, clock, searchProvider, jobBoardProvider })`
 * directly instead, exactly like domains/vacancies's own crawler tests inject a fake transport
 * rather than hitting the network. */
export const vacanciesAdapter: DomainAdapter = createVacanciesAdapter();
