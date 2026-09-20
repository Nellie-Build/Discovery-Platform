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
import { normalizeJobBoardLocation } from './location.js';
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

export function createTsJobSpySourceProvider(options: TsJobSpySourceProviderOptions = {}): VacancySourceProvider {
  const scrape = options.scrapeJobsImpl ?? scrapeJobs;
  const configuredSites = options.sites?.length ? options.sites : JOB_BOARD_SITES;
  const sites = Array.isArray(configuredSites) ? configuredSites : configuredSites ? [configuredSites] : [];
  return {
    id: 'ts-jobspy',
    async findCandidates(query: VacancySourceQuery): Promise<VacancySourceResult> {
      // `query.location` here is the user's raw "Regio" text (e.g. "Nederland", "Zuid-Holland",
      // "Den Haag") — normalized into ts-jobspy's own two distinct parameters. A recognized
      // country name (e.g. "Nederland" -> "netherlands") sets `country` explicitly, so Indeed
      // searches the right country domain instead of ts-jobspy's own "usa" default; LinkedIn
      // ignores `country` entirely and is given the same location as readable English text
      // instead of the raw Dutch word, since LinkedIn's own search takes `location` as a plain
      // string with no geo-resolution of its own (see this file's own header comment). A bare
      // region/city with no recognizable country (e.g. "Den Haag" alone) still leaves `country`
      // unset — ts-jobspy then falls back to its own "usa" default for Indeed; this is a known,
      // accepted limit of a single free-text "Regio" field with no separate country input, never
      // "fixed" by guessing which country a city belongs to.
      const { location, country } = normalizeJobBoardLocation(query.location);
      const outcomes = await Promise.all(sites.map(async site => {
        const started = Date.now();
        const timeoutMs = Math.max(500, Math.floor(((query.timeoutMs ?? 18_000) - 500) / 2));
        for (let attempt = 1; ; attempt++) {
          let candidates: VacancySourceCandidate[] = [];
          let meta: VacancySourceMeta;
          try {
            const result = await scrape({
              sites: [site], timeoutMs,
              searchTerm: query.query,
              location: location ?? undefined,
              country: country ?? undefined,
              resultsWanted: query.resultsWanted ?? options.resultsWanted ?? DEFAULT_RESULTS_WANTED,
              hoursOld: query.hoursOld ?? undefined,
              isRemote: query.remote ?? undefined,
            });
            candidates = result.jobs.filter(job => job.site === site).map(job => ({ ...mapJobToCandidate(job), site }));
            const reported = result.meta.sites.find(item => item.site === site);
            meta = reported ? mapSiteMeta(reported) : { provider: 'ts-jobspy', site, status: 'unavailable', candidates: candidates.length, durationMs: Date.now() - started, error: 'Bron rapporteerde geen status.', errorType: 'provider_error' };
          } catch (error) {
            const failure = sourceFailure(error);
            meta = { provider: 'ts-jobspy', site, status: failure.errorType === 'rate_limited' ? 'rate_limited' : 'error', candidates: 0, durationMs: Date.now() - started, ...failure };
          }
          if (attempt === 1 && candidates.length === 0 && ['timeout', 'network'].includes(meta.errorType ?? '')
            && Date.now() - started + timeoutMs + 250 <= (query.timeoutMs ?? 18_000)) { await sleep(250); continue; }
          // Never retry 429; any Retry-After is recorded and this source stops for the run.
          return { candidates, meta: { ...meta, attempts: attempt, durationMs: Date.now() - started } };
        }
      }));
      return { candidates: outcomes.flatMap(result => result.candidates), meta: outcomes.map(result => result.meta) };
    },
  };
}
