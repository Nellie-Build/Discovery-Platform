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
  crawlWebsite, fetchAndExtractPage, normalizeCandidateUrls, createBraveSearchProvider, websiteScope,
  type CrawlOptions, type SourceSearchProvider,
} from '@discovery-platform/core';
import {
  extractVacancy, extractVacancyWithDiagnostic, vacanciesCrawlerConfig, vacancyCompletenessScore, findVacancyDuplicates,
  buildBranchSearchQuery, buildJobBoardSearchTerm, createTsJobSpySourceProvider, scoreVacancyRelevance, isWithinPostedWindow,
  isSearchBreadth, DEFAULT_SEARCH_BREADTH, SEARCH_BREADTH_LIMITS,
  summarizeSources, sourceFailure,
  type VacancyFacts, type VacancySourceProvider, type VacancySourceCandidate, type VacancySourceMeta, type SearchBreadth,
  type VacancyPageDiagnostic,
} from '@discovery-platform/domain-vacancies';
import type { DomainAdapter, ExistingRecordSnapshot, DiscoveryRunInput, DiscoveryRunOutcome, DiscoveredRecord } from '../domain-registry.js';
// Imported directly from its own module, never through domain-registry.js — that file itself
// imports this adapter (for the `vacanciesAdapter` constant), so importing back through it here
// would create an ESM circular import (domain-registry.js <-> vacancies-adapter.js).
import { resolveDiscoveryRunConfig } from '../discovery-run-config.js';
import { computeBranchBreakdown, type FactOutcome, type SiteProgress } from './run-breakdown.js';

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

const BRANCH_SEARCH_COUNTRY = 'NL';
const BRANCH_SEARCH_LANGUAGE = 'nl';

/** Runs `fn` against a hard deadline — a provider that hangs (or is simply slow) is treated
 * exactly like any other provider failure: isolated, reported in stats.sources, and never allowed
 * to block the other source from still contributing (see runBranchDiscovery's own per-source
 * try/catch). Never used to abort real in-flight work, only to stop *waiting* on it. */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    fn().then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

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

/** Vacancy-specific filters carried opaquely through `DiscoveryRunInput.filters` — apps/api never
 * inspects this shape itself. `sources` only ever matters for branch mode (see runBranchDiscovery);
 * website mode simply never reads it. */
interface VacancySearchFilters {
  postedWithinDays?: number;
  sources?: string[];
}

function readFilters(raw: Record<string, unknown> | null | undefined): VacancySearchFilters {
  const source = raw ?? {};
  const postedWithinDays = typeof source.postedWithinDays === 'number' && Number.isFinite(source.postedWithinDays) && source.postedWithinDays > 0
    ? Math.floor(source.postedWithinDays) : undefined;
  const sources = Array.isArray(source.sources) ? source.sources.filter((v): v is string => typeof v === 'string') : undefined;
  return { postedWithinDays, sources };
}

/** Shared by both modes: apply the "posted within N days" filter (see date-filter.ts's own doc
 * comment — an unknown postedDate is never auto-rejected), collapse within-run duplicates, drop
 * anything already persisted for this project (unless `onlyNewRecords` is off), score what
 * survives, and shape it into the generic DiscoveredRecord[] apps/api persists — website mode and
 * branch mode (and, within branch mode, each of its sources) differ only in *how* `freshFacts` was
 * gathered. */
function buildRecordsFromFacts(
  freshFacts: VacancyFacts[], existingRecords: ExistingRecordSnapshot[],
  options: { postedWithinDays?: number; onlyNewRecords: boolean },
) {
  const dateFiltered = options.postedWithinDays
    ? freshFacts.filter(fact => !isWithinPostedWindow(fact, { postedWithinDays: options.postedWithinDays }))
    : [];
  const dated = options.postedWithinDays
    ? freshFacts.filter(fact => isWithinPostedWindow(fact, { postedWithinDays: options.postedWithinDays }))
    : freshFacts;

  const { survivors, collapsed } = collapseDuplicatesWithinCrawl(dated);
  // What happened to each fact — one exclusive outcome per fact, used for the run breakdown.
  const outcomes = new Map<VacancyFacts, FactOutcome>();
  for (const fact of dateFiltered) outcomes.set(fact, 'date_rejected');
  const survivorSet = new Set(survivors);
  for (const fact of dated) if (!survivorSet.has(fact)) outcomes.set(fact, 'duplicate_in_run');
  const existingFacts = existingRecords.map(record => record.domainData as unknown as VacancyFacts);
  let duplicatesAgainstExisting = 0;
  const records: DiscoveredRecord[] = [];
  const observedRecords: DiscoveredRecord[] = [];
  for (const fact of survivors) {
    const matching = findVacancyDuplicates([...existingFacts, fact]).find(c => c.decision === 'duplicate' && (c.vacancyA === fact || c.vacancyB === fact));
    const existingIndex = matching ? existingFacts.indexOf(matching.vacancyA === fact ? matching.vacancyB : matching.vacancyA) : -1;
    const existingRecordId = existingIndex >= 0 ? existingRecords[existingIndex].id : undefined;
    const completeness = vacancyCompletenessScore(fact);
    const record: DiscoveredRecord = {
      existingRecordId,
      displayName: fact.title ?? fact.company ?? null,
      domainData: fact as unknown as Record<string, unknown>,
      classification: { presentSignals: completeness.presentSignals, missingSignals: completeness.missingSignals },
      score: completeness.score,
      sources: [{ sourceType: 'website', sourceUrl: fact.sourceUrl, sourceLabel: null, sourceData: {} }],
      contacts: buildContacts(fact),
    };
    if (existingRecordId) { observedRecords.push(record); duplicatesAgainstExisting++; }
    const duplicateOfExisting = options.onlyNewRecords && isDuplicateOfExisting(fact, existingFacts);
    outcomes.set(fact, existingRecordId || duplicateOfExisting ? 'already_known' : 'new');
    if (duplicateOfExisting) { if (!existingRecordId) duplicatesAgainstExisting++; continue; }
    records.push(record);
  }
  return { records, observedRecords, collapsed, duplicatesAgainstExisting, dateFilteredCount: dateFiltered.length, outcomes };
}

function resolveSearchProvider(overrides: VacanciesCrawlOverrides): SourceSearchProvider | undefined {
  if (overrides.searchProvider) return overrides.searchProvider;
  // Read lazily (never at module load) so a missing key is detected at the moment a branch
  // search is actually requested, exactly like createGeminiVisionProvider's own apiKey check —
  // website mode never touches this and is completely unaffected either way.
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  return apiKey ? createBraveSearchProvider(apiKey) : undefined;
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
    postedDate: primary.postedDate ?? s.postedDate ?? null,
    sourceUrl,
  };
}

/** A job-board candidate that already has structured data is never re-crawled by default — only
 * when the provider itself flagged `needsEnrichment` (important fields genuinely missing) *and*
 * the run's own enrichment budget (see SEARCH_BREADTH_LIMITS.maxEnrichments) is not yet
 * exhausted do we fetch its own URL once through the exact same fetchAndExtractPage()/
 * extractVacancy() flow a website crawl uses, then fill in only the fields the job board left
 * null. The job board's own fields always win over anything enrichment finds. */
async function completeJobBoardCandidate(candidate: VacancySourceCandidate, overrides: VacanciesCrawlOverrides, enrichmentBudget: { remaining: number }): Promise<VacancyFacts> {
  if (!candidate.needsEnrichment || enrichmentBudget.remaining <= 0) return fillMissing(candidate.facts, undefined, candidate.sourceUrl);
  enrichmentBudget.remaining--;
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
  const runStart = Date.now();
  const config = input.runConfig ?? resolveDiscoveryRunConfig(undefined);
  const filters = readFilters(input.filters);
  const recordOptions = { postedWithinDays: filters.postedWithinDays, onlyNewRecords: config.onlyNewRecords };

  // Every crawled HTML page's own extraction diagnostic is collected here as a byproduct of the
  // `extract` callback below — never the page's own HTML or any personal data, just counts/
  // booleans/a reason code (see VacancyPageDiagnostic's own doc comment). This is what makes it
  // observable *why* a given page did or didn't become a record, without changing
  // discovery-core's own generic `extract` contract (still just returns facts).
  const diagnostics: VacancyPageDiagnostic[] = [];
  let evaluatedFacts = -1;
  let acceptedCount = 0;
  const knownCandidates = new Map<string, string | null>();
  for (const record of input.existingRecords) {
    const url = record.domainData.sourceUrl;
    if (typeof url === 'string') {
      try { const canonical = websiteScope(input.sourceUrl).normalize(url); if (canonical) knownCandidates.set(canonical, null); } catch { /* Ignore old malformed evidence. */ }
    }
  }
  const crawl = await crawlWebsite(input.sourceUrl, {
    rankCandidate: vacanciesCrawlerConfig.rankCandidate,
    knownCandidates,
    extract: page => {
      const { facts, diagnostic } = extractVacancyWithDiagnostic(page);
      diagnostics.push(diagnostic);
      return facts;
    },
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
    contactNormalizers,
    transport: overrides.transport,
    clock: overrides.clock,
    maxPages: config.maxPages,
    maxCandidates: config.maxCandidates,
    maxDurationMs: config.maxDurationMs,
    // Re-runs the full (already fast, already tested) accept/dedupe pipeline against everything
    // extracted so far after every page — simpler and safer than maintaining a second, incremental
    // version of the same dedupe logic, and cheap enough at the page counts a real run reaches.
    // Stops the crawl the moment enough *accepted* records exist, never merely enough candidates.
    shouldContinue: extractedSoFar => {
      if (evaluatedFacts !== extractedSoFar.length) {
        evaluatedFacts = extractedSoFar.length;
        acceptedCount = buildRecordsFromFacts(extractedSoFar.map(page => page.data), input.existingRecords, recordOptions).records.length;
      }
      return acceptedCount < config.targetRecords;
    },
  });
  const freshFacts = crawl.extractedPages.map(page => page.data);
  const built = buildRecordsFromFacts(freshFacts, input.existingRecords, recordOptions);
  const { collapsed, duplicatesAgainstExisting, dateFilteredCount } = built;
  const records = built.records.slice(0, config.targetRecords);

  const rejectionReasons: Record<string, number> = {};
  let pagesAccepted = 0, pagesWithVacancySignals = 0;
  for (const d of diagnostics) {
    if (d.accepted) pagesAccepted++;
    if (d.titleFound || d.metadataFieldsFound > 0 || d.descriptionFound || d.directContactFound) pagesWithVacancySignals++;
    if (!d.accepted && d.rejectionReason) rejectionReasons[d.rejectionReason] = (rejectionReasons[d.rejectionReason] ?? 0) + 1;
  }

  return {
    records,
    observedRecords: built.observedRecords,
    stats: {
      searchMode: 'website',
      crawlStatus: crawl.status,
      pagesVisited: crawl.pagesVisited,
      factsFound: freshFacts.length,
      duplicatesWithinCrawl: collapsed,
      duplicatesAgainstExisting,
      duplicates: collapsed + duplicatesAgainstExisting,
      recordsCreated: records.length,
      pagesWithVacancySignals,
      pagesAccepted,
      pagesRejected: diagnostics.length - pagesAccepted,
      rejectionReasons,
      pageDiagnostics: diagnostics,
      // Run-target reporting (see DiscoveryRunConfig) — a run stops as soon as one of these is
      // true: recordsAccepted >= targetRecords, or discovery-core's own stopReason fires first.
      targetRecords: config.targetRecords,
      recordsAccepted: records.length,
      candidatesDiscovered: crawl.candidatesDiscovered,
      ...crawl.discoveryStats,
      candidateDiagnostics: crawl.candidates,
      dateFilteredCount,
      maxPages: config.maxPages,
      budgetSource: config.budgetSource,
      maxCandidates: config.maxCandidates,
      maxDurationMs: config.maxDurationMs,
      durationMs: Date.now() - runStart,
      stopReason: crawl.stopReason,
    },
  };
}

// Web search (Brave) participates from 'standard' up when no explicit `sources` selection is
// given — 'focused' is job boards only (see SEARCH_BREADTH_LIMITS's own doc comment). Always
// additionally gated on actually being configured (see resolveSearchProvider) — an unconfigured
// optional source is never attempted, explicitly requested or not (see resolveSourceSelection).
const WEB_SEARCH_BREADTH_TIERS: SearchBreadth[] = ['standard', 'broad', 'advanced'];

/** Every vacancy source id this module knows how to select — what "enabled providers" means for
 * `filters.sources` validation (see resolveSourceSelection). Indeed and LinkedIn are two
 * separately selectable ids even though production serves both through one ts-jobspy call (see
 * sources/jobspy-source.ts's own `sites` option) — the user-facing choice and the underlying
 * request shape are deliberately decoupled. */
const VACANCY_SOURCE_IDS = ['indeed', 'linkedin', 'web_search'] as const;
type VacancySourceId = typeof VACANCY_SOURCE_IDS[number];
function isKnownVacancySource(id: string): id is VacancySourceId {
  return (VACANCY_SOURCE_IDS as readonly string[]).includes(id);
}

interface ResolvedSourceSelection {
  jobBoardSites: Array<'indeed' | 'linkedin'>;
  useWebSearch: boolean;
  /** True only when the caller explicitly listed "web_search" in `filters.sources` — as opposed
   * to `useWebSearch` being true just because the breadth tier's own default includes it. Gates
   * the "requested but not configured" notice below: a tier's own implicit default silently
   * contributing nothing (today's original behavior) is not the same as a user's own explicit
   * request going unmet, which deserves a clear, visible message (see section 9 of the brief this
   * shipped with — "Disabled/unavailable provider: duidelijke melding"). */
  webSearchExplicitlyRequested: boolean;
  /** Requested but not a recognized source id at all — reported in `stats.sources` as a clear,
   * isolated error entry, never silently ignored and never failing the rest of the run. */
  unknownSources: string[];
}

/** No explicit `sources` at all falls back to the breadth tier's own defaults — today's original,
 * unchanged behavior. An explicit (possibly empty after filtering) selection always wins outright:
 * requesting only `["web_search"]` means indeed/linkedin are deliberately excluded, not "use the
 * tier's default anyway". */
function resolveSourceSelection(sources: string[] | undefined, breadth: SearchBreadth): ResolvedSourceSelection {
  if (!sources) {
    return {
      jobBoardSites: ['indeed', 'linkedin'], useWebSearch: WEB_SEARCH_BREADTH_TIERS.includes(breadth),
      webSearchExplicitlyRequested: false, unknownSources: [],
    };
  }
  return {
    jobBoardSites: sources.filter((id): id is 'indeed' | 'linkedin' => id === 'indeed' || id === 'linkedin'),
    useWebSearch: sources.includes('web_search'),
    webSearchExplicitlyRequested: sources.includes('web_search'),
    unknownSources: sources.filter(id => !isKnownVacancySource(id)),
  };
}

/**
 * Source Discovery for vacancies: branch query -> (job-board provider, site-filtered by the
 * caller's own source selection, + optional web-search provider) -> candidates -> normalize/
 * dedupe -> the existing vacancy crawler/extractor for enrichment only where needed -> the
 * existing plausibility filtering (inside extractVacancy itself) -> the exact same scoring/dedupe
 * website mode already uses. Either source failing (or timing out — see withTimeout) is isolated:
 * reported in `stats.sources`, never discarding the other source's candidates. Stops requesting
 * further enrichment/candidates as soon as `runConfig.targetRecords` accepted records exist —
 * see the per-candidate `recordsAccepted` check below, the same idea as website mode's own
 * `shouldContinue`, just inline since branch mode has no single crawl loop to hook into.
 */
async function runBranchDiscovery(
  input: Extract<DiscoveryRunInput, { mode: 'branch' }>,
  overrides: VacanciesCrawlOverrides,
): Promise<DiscoveryRunOutcome> {
  const runStart = Date.now();
  const config = input.runConfig ?? resolveDiscoveryRunConfig(undefined);
  const filters = readFilters(input.filters);
  const breadth: SearchBreadth = isSearchBreadth(config.searchBreadth) ? config.searchBreadth : DEFAULT_SEARCH_BREADTH;
  const limits = SEARCH_BREADTH_LIMITS[breadth];
  const { jobBoardSites, useWebSearch, webSearchExplicitlyRequested, unknownSources } = resolveSourceSelection(filters.sources, breadth);
  const recordOptions = { postedWithinDays: filters.postedWithinDays, onlyNewRecords: config.onlyNewRecords };

  const enrichmentBudget = { remaining: config.maxEnrichments };
  let totalCandidatesUsed = 0;
  const remainingCandidateBudget = () => Math.max(0, config.maxCandidates - totalCandidatesUsed);
  // Request enough candidates to plausibly satisfy the target, never fewer than the breadth
  // tier's own sensible minimum, and never more than the overall candidate budget allows.
  const perProviderRequestSize = Math.max(1, Math.min(config.maxCandidates, Math.max(limits.maxCandidatesPerProvider, config.targetRecords)));

  // Both queries preserve user branch and keywords. Web Search also receives the region;
  // job boards receive it as a separate location/country parameter. No hidden expansion.
  const webSearchQuery = buildBranchSearchQuery({ branch: input.branch, region: input.region, keywords: input.keywords });
  const jobBoardSearchTerm = buildJobBoardSearchTerm({ branch: input.branch, keywords: input.keywords });
  const sources: VacancySourceMeta[] = [];
  const freshFacts: VacancyFacts[] = [];
  // Per-provider funnel bookkeeping for stats.breakdown (see run-breakdown.ts).
  const perSite = new Map<string, SiteProgress>();
  const factSite = new Map<VacancyFacts, string>();
  const siteProgress = (site: string): SiteProgress => {
    let progress = perSite.get(site);
    if (!progress) perSite.set(site, progress = { discovered: 0, attempted: 0, withData: 0 });
    return progress;
  };
  let candidatesFound = 0;
  let candidatesCrawled = 0;
  let stopReason: string = 'provider_exhausted';

  for (const id of unknownSources) {
    sources.push({ provider: id, site: id, status: 'unavailable', candidates: 0, durationMs: 0, error: 'Onbekende of niet beschikbare bron.', errorType: 'source_unavailable' });
  }

  /** Applies relevance (query-specific, branch mode only) + date filtering + dedupe to everything
   * gathered so far, and reports how many are currently accepted — the same check `recordsAccepted
   * >= targetRecords` website mode's own `shouldContinue` makes, just called inline here between
   * candidates instead of between crawled pages. */
  function acceptedSoFar(): number {
    const relevant = freshFacts.filter(fact => scoreVacancyRelevance(fact, { branch: input.branch, keywords: input.keywords }).accepted);
    return buildRecordsFromFacts(relevant, input.existingRecords, recordOptions).records.length;
  }
  function targetReached(): boolean {
    return acceptedSoFar() >= config.targetRecords;
  }
  function timeUp(): boolean {
    return Date.now() - runStart >= config.maxDurationMs;
  }

  // The job board (ts-jobspy: Indeed and/or LinkedIn, per the caller's own source selection) — no
  // API key required. This is branch mode's primary source; a failure (or a timeout) here is
  // isolated and never prevents web search (below) from still contributing.
  if (jobBoardSites.length > 0 && !targetReached() && !timeUp()) {
    try {
      const jobBoard = overrides.jobBoardProvider ?? createTsJobSpySourceProvider({ sites: jobBoardSites });
      const jobBoardResult = await withTimeout(
        () => jobBoard.findCandidates({ query: jobBoardSearchTerm, location: input.region, resultsWanted: perProviderRequestSize,
          hoursOld: filters.postedWithinDays ? filters.postedWithinDays * 24 : undefined,
          timeoutMs: Math.min(limits.providerTimeoutMs - 500, config.maxDurationMs - (Date.now() - runStart) - 500) }),
        Math.min(limits.providerTimeoutMs, config.maxDurationMs - (Date.now() - runStart)),
      );
      sources.push(...jobBoardResult.meta);
      candidatesFound += jobBoardResult.candidates.length;
      for (const candidate of jobBoardResult.candidates) siteProgress(candidate.site ?? 'ts-jobspy').discovered++;
      for (const candidate of jobBoardResult.candidates) {
        if (targetReached()) { stopReason = 'target_reached'; break; }
        if (timeUp()) { stopReason = 'time_limit'; break; }
        if (remainingCandidateBudget() <= 0) { stopReason = 'candidate_limit'; break; }
        totalCandidatesUsed++;
        const progress = siteProgress(candidate.site ?? 'ts-jobspy');
        progress.attempted++;
        const fact = await completeJobBoardCandidate(candidate, overrides, enrichmentBudget);
        freshFacts.push(fact);
        factSite.set(fact, candidate.site ?? 'ts-jobspy');
        progress.withData++;
        candidatesCrawled++;
      }
    } catch (error) {
      const failure = sourceFailure(error);
      sources.push(...jobBoardSites.map(site => ({ provider: 'ts-jobspy', site, status: failure.errorType === 'rate_limited' ? 'rate_limited' as const : 'error' as const, candidates: 0, durationMs: Date.now() - runStart, ...failure })));
    }
  }

  // Web search (Brave) — optional: no key configured means no attempt at all, it simply
  // contributes nothing, never a run failure (see resolveSearchProvider's own doc comment).
  const searchProvider = useWebSearch ? resolveSearchProvider(overrides) : undefined;
  if (!searchProvider) {
    sources.push({ provider: 'brave', site: 'brave', status: useWebSearch ? 'not_configured' : 'user_disabled', candidates: 0, durationMs: 0, error: null });
  }
  if (searchProvider && !targetReached() && !timeUp()) {
    const start = Date.now();
    try {
      const searchCap = Math.min(perProviderRequestSize, remainingCandidateBudget());
      const rawCandidates = await withTimeout(
        () => searchProvider.search({ query: webSearchQuery, country: BRANCH_SEARCH_COUNTRY, language: BRANCH_SEARCH_LANGUAGE, count: searchCap }),
        Math.min(limits.providerTimeoutMs, config.maxDurationMs - (Date.now() - runStart)),
      );
      const candidates = normalizeCandidateUrls(rawCandidates, { maxCandidates: searchCap });
      candidatesFound += candidates.length;
      siteProgress('brave').discovered += candidates.length;
      let braveCrawled = 0;
      for (const candidate of candidates) {
        if (targetReached()) { stopReason = 'target_reached'; break; }
        if (timeUp()) { stopReason = 'time_limit'; break; }
        if (remainingCandidateBudget() <= 0 || enrichmentBudget.remaining <= 0) { stopReason = 'candidate_limit'; break; }
        totalCandidatesUsed++;
        enrichmentBudget.remaining--;
        siteProgress('brave').attempted++;
        const result = await fetchAndExtractPage(candidate.url, {
          extract: extractVacancy,
          contactNormalizers,
          linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
          transport: overrides.transport,
        });
        if (result.status !== 'succeeded') continue;
        braveCrawled++;
        candidatesCrawled++;
        if (result.data?.length) {
          freshFacts.push(...result.data);
          for (const fact of result.data) factSite.set(fact, 'brave');
          siteProgress('brave').withData++;
        }
      }
      sources.push({
        provider: 'brave', site: 'brave', status: candidates.length === 0 ? 'empty' : 'ok',
        candidates: candidates.length, durationMs: Date.now() - start, error: null,
      });
    } catch (error) {
      const failure = sourceFailure(error);
      sources.push({ provider: 'brave', site: 'brave', status: failure.errorType === 'rate_limited' ? 'rate_limited' : 'error', candidates: 0, durationMs: Date.now() - start, ...failure });
    }
  }

  if (targetReached()) stopReason = 'target_reached';
  else if (timeUp()) stopReason = 'time_limit';

  // Query relevance — the pipeline stage between plausibility (already applied per-candidate
  // above: extractVacancy's own isPlausibleVacancyPage for Brave candidates; ts-jobspy results
  // are trusted structured job postings and skip that specific check) and dedupe. Only branch
  // mode has a query to be relevant to; website mode never reaches this function at all, so it
  // stays completely unaffected (see runWebsiteDiscovery above).
  const candidatesReceived = freshFacts.length;
  const relevantFacts: VacancyFacts[] = [];
  for (const fact of freshFacts) {
    if (scoreVacancyRelevance(fact, { branch: input.branch, keywords: input.keywords }).accepted) relevantFacts.push(fact);
  }
  const relevantSet = new Set(relevantFacts);
  const relevanceAccepted = relevantFacts.length;
  const relevanceRejected = candidatesReceived - relevanceAccepted;

  const built = buildRecordsFromFacts(relevantFacts, input.existingRecords, recordOptions);
  const { collapsed, duplicatesAgainstExisting, dateFilteredCount } = built;
  const records = built.records.slice(0, config.targetRecords);
  const storedFacts = new Set(records.filter(record => !record.existingRecordId).map(record => record.domainData as unknown as VacancyFacts));
  const breakdown = computeBranchBreakdown({
    perSite, freshFacts, factSite, relevant: relevantSet, outcomes: built.outcomes, stored: storedFacts,
    reseenRecords: records.filter(record => record.existingRecordId).length,
  });
  const relevanceQuery = { branch: input.branch, keywords: input.keywords, region: input.region };
  for (const record of [...records, ...built.observedRecords]) record.classification = { ...record.classification, relevance: scoreVacancyRelevance(record.domainData as unknown as VacancyFacts, relevanceQuery) };
  for (const site of ['indeed', 'linkedin', 'brave']) {
    if (sources.some(source => source.site === site)) continue;
    const selected = site === 'brave' ? useWebSearch : jobBoardSites.includes(site as 'indeed' | 'linkedin');
    sources.push({ provider: site === 'brave' ? 'brave' : 'ts-jobspy', site, status: selected ? 'not_run' : 'user_disabled', candidates: 0, durationMs: 0, error: null });
  }
  const coverage = summarizeSources(sources);
  if (coverage.status === 'failed') stopReason = coverage.stopReason ?? 'source_unavailable';
  else if (stopReason === 'provider_exhausted') stopReason = coverage.stopReason ?? (candidatesFound === 0 ? 'no_results' : 'provider_exhausted');
  return {
    records,
    status: coverage.status,
    observedRecords: built.observedRecords,
    stats: {
      ...coverage,
      providerQueries: Object.fromEntries(sources.filter(source => ['ok', 'empty', 'partial', 'error', 'rate_limited'].includes(source.status))
        .map(source => [source.site, source.site === 'brave' ? webSearchQuery : jobBoardSearchTerm])),
      candidatesRelevant: relevanceAccepted,
      candidatesRejectedByRelevance: relevanceRejected,
      breakdown,
      relevanceDiagnostics: freshFacts.map(fact => ({ sourceUrl: fact.sourceUrl, ...scoreVacancyRelevance(fact, relevanceQuery) })),
      searchMode: 'branch',
      searchBreadth: breadth,
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
      candidatesReceived,
      relevanceAccepted,
      relevanceRejected,
      duplicatesWithinCrawl: collapsed,
      duplicatesAgainstExisting,
      duplicates: collapsed + duplicatesAgainstExisting,
      recordsCreated: records.length,
      // Run-target reporting (see DiscoveryRunConfig) — mirrors website mode's own stats shape.
      targetRecords: config.targetRecords,
      recordsAccepted: records.length,
      candidatesDiscovered: candidatesFound,
      candidatesProcessed: candidatesCrawled,
      candidatesRemaining: Math.max(0, candidatesFound - candidatesCrawled),
      dateFilteredCount,
      maxPages: config.maxPages,
      budgetSource: config.budgetSource,
      maxCandidates: config.maxCandidates,
      maxDurationMs: config.maxDurationMs,
      durationMs: Date.now() - runStart,
      stopReason,
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
