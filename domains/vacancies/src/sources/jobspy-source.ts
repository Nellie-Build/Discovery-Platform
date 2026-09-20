/**
 * Wraps ts-jobspy (MIT) — the only file in this domain module allowed to import it (see
 * tests/dependency-boundary.test.mjs). Nothing outside domains/vacancies ever imports ts-jobspy
 * directly or sees its types: apps/api only ever sees this file's own VacancySourceProvider,
 * VacancySourceCandidate and VacancySourceMeta — see apps/api/src/domains/vacancies-adapter.ts.
 *
 * A ts-jobspy job is only ever a *candidate*: this file turns it into a Partial<VacancyFacts>
 * using exactly what the job board actually reported — hours/contactPerson/phone are never part
 * of a ts-jobspy job and are always left absent here, never guessed. Our own pipeline
 * (normalization, scoring, dedupe, plausibility for anything that does get enriched) stays
 * entirely in charge downstream — this file's only job is the mapping.
 */
import { scrapeJobs, type ScrapeOptions, type Job, type SiteMeta } from 'ts-jobspy';
import type { VacancyFacts } from '../extract-vacancy.js';
import { resolveSearchLocation, jobBoardLocationFor } from './location.js';
import { sourceFailure } from './outcome.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { VacancySourceProvider, VacancySourceQuery, VacancySourceCandidate, VacancySourceMeta, VacancySourceResult } from './types.js';

/** Only the sites ts-jobspy's own README currently documents as actually working, without a
 * proxy or a browser (Indeed and LinkedIn) — every other site it knows about (Google, Glassdoor,
 * ZipRecruiter, Bayt, Naukri, BDJobs) is blocked/unreliable upstream today. Revisit this list
 * once ts-jobspy itself reports more sites as working. */
const JOB_BOARD_SITES: ScrapeOptions['sites'] = ['indeed', 'linkedin'];
const DEFAULT_RESULTS_WANTED = 10;

function text(v: string | null | undefined, max = 500): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

function buildSalary(job: Job): string | null {
  const amount = job.minAmount != null && job.maxAmount != null ? `${job.minAmount}-${job.maxAmount}`
    : job.minAmount != null ? String(job.minAmount)
    : job.maxAmount != null ? String(job.maxAmount)
    : null;
  if (!amount) return null;
  return [job.currency, amount, job.interval].filter((v): v is string => Boolean(v)).join(' ');
}

/**
 * A candidate needs optional enrichment when the two fields a job board almost never omits
 * (description) or the only direct-contact field it can give (an email) are both missing —
 * genuinely thin data, not just "could theoretically have more fields".
 */
function mapJobToCandidate(job: Job): VacancySourceCandidate {
  const description = text(job.description, 10_000);
  const email = job.emails[0] ?? null;
  // job.datePosted is already a plain YYYY-MM-DD (ts-jobspy's own doc comment: "UTC calendar
  // date of the posting instant, when the site reports one") — an explicit provider-reported
  // date, never inferred here.
  const postedDate = text(job.datePosted, 10);
  const facts: Partial<VacancyFacts> = {
    title: text(job.title),
    company: text(job.company),
    location: text(job.location),
    salary: buildSalary(job),
    hours: null,
    contractType: job.jobTypes.length ? job.jobTypes.join(', ') : null,
    description,
    contactPerson: null,
    phone: null,
    email,
    postedDate,
  };
  return {
    facts,
    sourceUrl: job.jobUrlDirect || job.jobUrl,
    needsEnrichment: !description && !email,
  };
}

function mapSiteMeta(site: SiteMeta): VacancySourceMeta {
  const failure = site.status === 'error' || site.status === 'partial' ? sourceFailure(site.error) : null;
  return {
    provider: 'ts-jobspy',
    site: site.site,
    status: failure?.errorType === 'rate_limited' && site.jobs === 0 ? 'rate_limited' : site.status,
    candidates: site.jobs,
    durationMs: site.durationMs,
    error: failure?.error ?? null,
    ...(failure ?? {}),
  };
}

export interface TsJobSpySourceProviderOptions {
  /** Jobs requested per site (not a total) — a conservative default, never unbounded. */
  resultsWanted?: number;
  /** Which of the two working sites (see this file's own header comment) this provider instance
   * actually queries — defaults to both, exactly like before this option existed. A caller that
   * wants "Indeed only" or "LinkedIn only" as its own separately selectable source (see the
   * vacancies module's own provider registry) constructs two instances, one per site, rather than
   * this file ever needing to know about "source selection" as a concept itself. */
  sites?: ScrapeOptions['sites'];
  /** Test-only injection point — never used in production, where the real ts-jobspy scrapeJobs
   * is always called. Mirrors the fetchImpl seam @discovery-platform/core's own providers use. */
  scrapeJobsImpl?: typeof scrapeJobs;
}

/**
 * What each site can deliver inside one provider timeout, measured against the live sites:
 * Indeed answers in one request (50 results in ~0.4 s), LinkedIn returns 10 results per page with a
 * random 3-7 s pause between pages (30 results took ~12 s), so asking LinkedIn for more than ~30 in
 * one run only ends in a timeout with partial results. Requests above a site's capacity are capped
 * to it; the cap is reported as `requestedCandidates`.
 */
export const JOB_BOARD_SITE_PROFILES: Record<string, { maxResults: number }> = {
  indeed: { maxResults: 100 },
  linkedin: { maxResults: 30 },
};
const DEFAULT_SITE_MAX_RESULTS = 30;
/** ts-jobspy enforces `timeoutMs` itself (and returns partial results); this guard only makes sure
 * one site can never keep the whole provider waiting past that. */
const GUARD_GRACE_MS = 3_000;
/** A failed first attempt is only retried when this much of the provider budget is still left. */
const MIN_RETRY_BUDGET_MS = 5_000;

function guardTimeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref?.());
}

export function createTsJobSpySourceProvider(options: TsJobSpySourceProviderOptions = {}): VacancySourceProvider {
  const scrape = options.scrapeJobsImpl ?? scrapeJobs;
  const configuredSites = options.sites?.length ? options.sites : JOB_BOARD_SITES;
  const sites = Array.isArray(configuredSites) ? configuredSites : configuredSites ? [configuredSites] : [];
  return {
    id: 'ts-jobspy',
    async findCandidates(query: VacancySourceQuery): Promise<VacancySourceResult> {
      // `query.location` is the place ("Zuid-Holland") when `query.country` is given; without a
      // country it is the legacy free-text "Regio", which may itself be a country name. Either
      // way the content search term and the location are separate parameters: a place never ends
      // up in `searchTerm`. Indeed selects its country domain from `country` and only needs the
      // place; LinkedIn has no country parameter, so its location text carries both, in readable
      // English ("Zuid-Holland, Netherlands").
      const resolved = resolveSearchLocation({ country: query.country, region: query.location });
      const budgetMs = query.timeoutMs ?? 18_000;
      const providerStart = Date.now();
      // Sites run in parallel and each gets the whole provider budget (it used to be halved, which
      // cut LinkedIn off at ~9.5 s). One site failing or timing out never touches another's result.
      const outcomes = await Promise.all(sites.map(async site => {
        const started = Date.now();
        const requested = Math.max(1, Math.min(query.resultsWanted ?? options.resultsWanted ?? DEFAULT_RESULTS_WANTED,
          JOB_BOARD_SITE_PROFILES[site]?.maxResults ?? DEFAULT_SITE_MAX_RESULTS));
        const siteLocation = jobBoardLocationFor(site, resolved);
        for (let attempt = 1; ; attempt++) {
          const timeoutMs = Math.max(500, budgetMs - (Date.now() - providerStart) - 500);
          const diagnostics = { searchTerm: query.query, location: siteLocation, country: resolved.country, resultsWanted: requested, timeoutMs };
          let candidates: VacancySourceCandidate[] = [];
          let meta: VacancySourceMeta;
          try {
            const result = await Promise.race([
              scrape({
                sites: [site], timeoutMs,
                searchTerm: query.query,
                location: siteLocation ?? undefined,
                country: resolved.country ?? undefined,
                resultsWanted: requested,
                hoursOld: query.hoursOld ?? undefined,
                isRemote: query.remote ?? undefined,
              }),
              guardTimeout(timeoutMs + GUARD_GRACE_MS),
            ]);
            candidates = result.jobs.filter(job => job.site === site).map(job => ({ ...mapJobToCandidate(job), site }));
            const reported = result.meta.sites.find(item => item.site === site);
            meta = reported ? mapSiteMeta(reported) : { provider: 'ts-jobspy', site, status: 'unavailable', candidates: candidates.length, durationMs: Date.now() - started, error: 'Bron rapporteerde geen status.', errorType: 'provider_error' };
          } catch (error) {
            const failure = sourceFailure(error);
            meta = { provider: 'ts-jobspy', site, status: failure.errorType === 'rate_limited' ? 'rate_limited' : 'error', candidates: 0, durationMs: Date.now() - started, ...failure };
          }
          // One retry, only for a transient failure with nothing returned and enough budget left.
          // Never for a 429 (rate_limited); a Retry-After hint is kept when the source gives one.
          const remaining = budgetMs - (Date.now() - providerStart);
          if (attempt === 1 && candidates.length === 0 && ['timeout', 'network'].includes(meta.errorType ?? '')
            && remaining >= MIN_RETRY_BUDGET_MS) { await sleep(250); continue; }
          return { candidates, meta: { ...meta, attempts: attempt, durationMs: Date.now() - started, query: diagnostics,
            requestedCandidates: requested, returnedCandidates: candidates.length } };
        }
      }));
      return { candidates: outcomes.flatMap(result => result.candidates), meta: outcomes.map(result => result.meta) };
    },
  };
}
