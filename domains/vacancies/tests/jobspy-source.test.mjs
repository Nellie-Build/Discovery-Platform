import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTsJobSpySourceProvider } from '../dist/sources/jobspy-source.js';

/** A minimal, fully-typed-shaped fake ts-jobspy Job — every field ts-jobspy's own type declares,
 * so a test only has to override what it actually cares about. */
function job(overrides = {}) {
  return {
    id: 'j1', site: 'indeed', jobUrl: 'https://indeed.example/job/1', jobUrlDirect: null,
    title: 'Security Officer', company: 'Acme Security', location: 'Den Haag',
    datePosted: '2026-09-01', jobTypes: [], salarySource: null, interval: null,
    minAmount: null, maxAmount: null, currency: null, isRemote: null,
    jobLevel: null, jobFunction: null, listingType: null, emails: [],
    description: 'We are hiring a security officer.', companyIndustry: null, companyUrl: null,
    companyLogo: null, bannerPhotoUrl: null, companyUrlDirect: null, companyAddresses: null,
    companyNumEmployees: null, companyRevenue: null, companyDescription: null, skills: [],
    experienceRange: null, companyRating: null, companyReviewsCount: null, vacancyCount: null,
    workFromHomeType: null,
    ...overrides,
  };
}
function siteMetaOk(site, jobs, overrides = {}) {
  return { site, jobs, requested: 10, durationMs: 500, jobsPerSecond: jobs / 0.5, status: jobs > 0 ? 'ok' : 'empty', ...overrides };
}
function siteMetaError(site, name, message) {
  return { site, jobs: 0, requested: 10, durationMs: 300, jobsPerSecond: 0, status: 'error', error: { name, message } };
}
function fakeScrapeJobs(result) {
  const calls = [];
  return { impl: async options => { calls.push(options); return result; }, calls };
}

test('sends query/location/resultsWanted/hoursOld/isRemote to scrapeJobs, requesting only Indeed and LinkedIn', async () => {
  const { impl, calls } = fakeScrapeJobs({ jobs: [], meta: { sites: [siteMetaOk('indeed', 0), siteMetaOk('linkedin', 0)], totalDurationMs: 1, jobsPerSecond: 0, failureRate: 0, duplicatesRemoved: 0 } });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  await provider.findCandidates({ query: 'vacature vacatures jobs Security beveiliger security officer Zuid-Holland', location: 'Zuid-Holland', resultsWanted: 10, hoursOld: 72, remote: false });
  assert.deepEqual(calls[0].sites, ['indeed', 'linkedin']);
  assert.equal(calls[0].searchTerm, 'vacature vacatures jobs Security beveiliger security officer Zuid-Holland');
  assert.equal(calls[0].location, 'Zuid-Holland');
  assert.equal(calls[0].resultsWanted, 10);
  assert.equal(calls[0].hoursOld, 72);
  assert.equal(calls[0].isRemote, false);
});

test('Indeed result mapping: an Indeed job is mapped to VacancyFacts using exactly the fields the job board gave, nothing invented', async () => {
  const indeedJob = job({
    site: 'indeed', title: 'Security Officer', company: 'Acme Security', location: 'Den Haag',
    jobUrl: 'https://indeed.example/job/1', jobUrlDirect: 'https://acme-security.example/careers/security-officer',
    jobTypes: ['fulltime'], minAmount: 2800, maxAmount: 3400, currency: 'EUR', interval: 'monthly',
    description: 'We are hiring a security officer.', emails: ['jobs@acme-security.example'],
  });
  const { impl } = fakeScrapeJobs({ jobs: [indeedJob], meta: { sites: [siteMetaOk('indeed', 1)], totalDurationMs: 500, jobsPerSecond: 2, failureRate: 0, duplicatesRemoved: 0 } });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Security', location: 'Den Haag' });
  assert.equal(result.candidates.length, 1);
  const [candidate] = result.candidates;
  assert.equal(candidate.sourceUrl, 'https://acme-security.example/careers/security-officer'); // jobUrlDirect preferred over jobUrl
  assert.deepEqual(candidate.facts, {
    title: 'Security Officer', company: 'Acme Security', location: 'Den Haag',
    salary: 'EUR 2800-3400 monthly', hours: null, contractType: 'fulltime',
    description: 'We are hiring a security officer.', contactPerson: null, phone: null,
    email: 'jobs@acme-security.example',
  });
  assert.equal(candidate.needsEnrichment, false); // has both description and an email
});

test('LinkedIn result mapping: a LinkedIn job with no salary/email is mapped with those fields null, never guessed, and is flagged for enrichment', async () => {
  const linkedinJob = job({
    site: 'linkedin', title: 'Beleidsadviseur Veiligheid', company: 'Gemeente Voorbeeld', location: 'Zuid-Holland',
    jobUrl: 'https://linkedin.example/jobs/view/2', jobUrlDirect: null,
    jobTypes: [], minAmount: null, maxAmount: null, currency: null, interval: null,
    description: null, emails: [],
  });
  const { impl } = fakeScrapeJobs({ jobs: [linkedinJob], meta: { sites: [siteMetaOk('linkedin', 1)], totalDurationMs: 400, jobsPerSecond: 2.5, failureRate: 0, duplicatesRemoved: 0 } });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Veiligheid', location: 'Zuid-Holland' });
  const [candidate] = result.candidates;
  assert.equal(candidate.sourceUrl, 'https://linkedin.example/jobs/view/2'); // falls back to jobUrl, no jobUrlDirect
  assert.equal(candidate.facts.salary, null);
  assert.equal(candidate.facts.email, null);
  assert.equal(candidate.facts.hours, null); // ts-jobspy never provides this
  assert.equal(candidate.facts.contactPerson, null); // ts-jobspy never provides this
  assert.equal(candidate.facts.phone, null); // ts-jobspy never provides this
  assert.equal(candidate.needsEnrichment, true); // no description and no email — genuinely thin
});

test('one site erroring does not discard the other site\'s candidates — per-site isolation, exactly like ts-jobspy\'s own meta', async () => {
  const { impl } = fakeScrapeJobs({
    jobs: [job({ site: 'indeed', title: 'Security Officer' })],
    meta: {
      sites: [siteMetaOk('indeed', 1), siteMetaError('linkedin', 'RateLimitException', 'linkedin: rate limited after page 10')],
      totalDurationMs: 900, jobsPerSecond: 1.1, failureRate: 0.5, duplicatesRemoved: 0,
    },
  });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Security' });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].facts.title, 'Security Officer');
  const indeedMeta = result.meta.find(m => m.site === 'indeed');
  const linkedinMeta = result.meta.find(m => m.site === 'linkedin');
  assert.equal(indeedMeta.status, 'ok');
  assert.equal(indeedMeta.candidates, 1);
  assert.equal(indeedMeta.error, null);
  assert.equal(linkedinMeta.status, 'error');
  assert.equal(linkedinMeta.candidates, 0);
  assert.match(linkedinMeta.error, /RateLimitException/);
  assert.match(linkedinMeta.error, /rate limited/);
});

test('an empty result for a site is reported as status "empty", not an error', async () => {
  const { impl } = fakeScrapeJobs({ jobs: [], meta: { sites: [siteMetaOk('indeed', 0)], totalDurationMs: 200, jobsPerSecond: 0, failureRate: 0, duplicatesRemoved: 0 } });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Nonexistent Branch XYZ' });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.meta[0].status, 'empty');
});

test('defaults resultsWanted to a conservative value (10) when the caller does not specify one', async () => {
  const { impl, calls } = fakeScrapeJobs({ jobs: [], meta: { sites: [], totalDurationMs: 1, jobsPerSecond: 0, failureRate: 0, duplicatesRemoved: 0 } });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  await provider.findCandidates({ query: 'Security' });
  assert.equal(calls[0].resultsWanted, 10);
});
