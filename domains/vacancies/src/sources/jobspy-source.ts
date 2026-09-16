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
  };
  return {
    facts,
    sourceUrl: job.jobUrlDirect || job.jobUrl,
    needsEnrichment: !description && !email,
  };
}

function mapSiteMeta(site: SiteMeta): VacancySourceMeta {
  return {
    provider: 'ts-jobspy',
    site: site.site,
    status: site.status,
    candidates: site.jobs,
    durationMs: site.durationMs,
    error: site.status === 'error' || site.status === 'partial' ? `${site.error.name}: ${site.error.message}` : null,
  };
}

export interface TsJobSpySourceProviderOptions {
  /** Jobs requested per site (not a total) — a conservative default, never unbounded. */
  resultsWanted?: number;
  /** Test-only injection point — never used in production, where the real ts-jobspy scrapeJobs
   * is always called. Mirrors the fetchImpl seam @discovery-platform/core's own providers use. */
  scrapeJobsImpl?: typeof scrapeJobs;
}

export function createTsJobSpySourceProvider(options: TsJobSpySourceProviderOptions = {}): VacancySourceProvider {
  const scrape = options.scrapeJobsImpl ?? scrapeJobs;
  return {
    id: 'ts-jobspy',
    async findCandidates(query: VacancySourceQuery): Promise<VacancySourceResult> {
      const result = await scrape({
        sites: JOB_BOARD_SITES,
        searchTerm: query.query,
        location: query.location ?? undefined,
        resultsWanted: query.resultsWanted ?? options.resultsWanted ?? DEFAULT_RESULTS_WANTED,
        hoursOld: query.hoursOld ?? undefined,
        isRemote: query.remote ?? undefined,
      });
      return {
        candidates: result.jobs.map(mapJobToCandidate),
        meta: result.meta.sites.map(mapSiteMeta),
      };
    },
  };
}
