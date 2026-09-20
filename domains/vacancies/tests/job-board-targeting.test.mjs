import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTsJobSpySourceProvider } from '../dist/sources/jobspy-source.js';
import { resolveSearchLocation, jobBoardLocationFor } from '../dist/sources/location.js';
import { removeLocationKeywords, buildJobBoardSearchTerm } from '../dist/source-discovery.js';
import { scoreVacancyRelevance } from '../dist/relevance.js';

function job(site, n, overrides = {}) {
  return {
    id: `${site}-${n}`, site, jobUrl: `https://${site}.example/job/${n}`, jobUrlDirect: null,
    title: `Docent ${n}`, company: 'School', location: 'Den Haag', datePosted: '2026-09-01', jobTypes: [],
    salarySource: null, interval: null, minAmount: null, maxAmount: null, currency: null, isRemote: null, jobLevel: null,
    jobFunction: null, listingType: null, emails: [], description: 'Onderwijs voor iedereen.', companyIndustry: null,
    companyUrl: null, companyLogo: null, bannerPhotoUrl: null, companyUrlDirect: null, companyAddresses: null,
    companyNumEmployees: null, companyRevenue: null, companyDescription: null, skills: [], experienceRange: null,
    companyRating: null, companyReviewsCount: null, vacancyCount: null, workFromHomeType: null, ...overrides,
  };
}
const siteMeta = (site, jobs, extra = {}) => ({ site, jobs, requested: 10, durationMs: 100, jobsPerSecond: 1, status: jobs ? 'ok' : 'empty', ...extra });
const envelope = (jobs, sites) => ({ jobs, meta: { sites, totalDurationMs: 1, jobsPerSecond: 0, failureRate: 0, duplicatesRemoved: 0 } });

/** A fake ts-jobspy that answers per site, so each test can make one site succeed and the other fail. */
function fakeScrape(perSite) {
  const calls = [];
  return { calls, impl: async options => {
    calls.push(options);
    const handler = perSite[options.sites[0]];
    return handler(options, calls.filter(call => call.sites[0] === options.sites[0]).length);
  } };
}

test('resolveSearchLocation keeps country and place apart, and stays compatible with a single free-text region', () => {
  assert.deepEqual(resolveSearchLocation({ country: 'Nederland', region: 'Zuid-Holland' }), { country: 'netherlands', countryLabel: 'Netherlands', place: 'Zuid-Holland' });
  assert.deepEqual(resolveSearchLocation({ region: 'Nederland' }), { country: 'netherlands', countryLabel: 'Netherlands', place: null });
  assert.deepEqual(resolveSearchLocation({ region: 'Den Haag' }), { country: null, countryLabel: null, place: 'Den Haag' });
  assert.deepEqual(resolveSearchLocation({ country: 'Nederland', region: 'Nederland' }), { country: 'netherlands', countryLabel: 'Netherlands', place: null });
  assert.deepEqual(resolveSearchLocation({}), { country: null, countryLabel: null, place: null });
  assert.equal(resolveSearchLocation({ country: 'Curacao', region: 'Willemstad' }).country, null, 'an unrecognized country is never guessed');
});

test('each job board gets its own native location: Indeed the place plus a country, LinkedIn a readable "place, country"', () => {
  const location = resolveSearchLocation({ country: 'Nederland', region: 'Zuid-Holland' });
  assert.equal(jobBoardLocationFor('indeed', location), 'Zuid-Holland');
  assert.equal(jobBoardLocationFor('linkedin', location), 'Zuid-Holland, Netherlands');
  assert.equal(jobBoardLocationFor('indeed', resolveSearchLocation({ region: 'Nederland' })), 'Netherlands');
});

test('the province goes to the location parameter and never into the search term; content keywords stay', async () => {
  const { impl, calls } = fakeScrape({ indeed: () => envelope([], [siteMeta('indeed', 0)]), linkedin: () => envelope([], [siteMeta('linkedin', 0)]) });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const searchTerm = buildJobBoardSearchTerm({ branch: 'Onderwijs', keywords: removeLocationKeywords('voortgezet onderwijs', ['Zuid-Holland']) });
  await provider.findCandidates({ query: searchTerm, location: 'Zuid-Holland', country: 'netherlands', resultsWanted: 40, timeoutMs: 20_000 });
  const indeed = calls.find(call => call.sites[0] === 'indeed');
  const linkedin = calls.find(call => call.sites[0] === 'linkedin');
  assert.equal(indeed.searchTerm, 'Onderwijs voortgezet onderwijs');
  assert.equal(indeed.location, 'Zuid-Holland');
  assert.equal(indeed.country, 'netherlands');
  assert.equal(linkedin.searchTerm, 'Onderwijs voortgezet onderwijs');
  assert.equal(linkedin.location, 'Zuid-Holland, Netherlands');
  for (const call of calls) assert.ok(!/holland/i.test(call.searchTerm));
});

test('a keyword that only repeats the location is removed from the content term (exact match only)', () => {
  assert.equal(removeLocationKeywords('zuid-holland', ['Zuid-Holland']), null);
  assert.equal(removeLocationKeywords('Zuid Holland', ['Zuid-Holland']), null);
  assert.equal(removeLocationKeywords('docent, zuid-holland', ['Zuid-Holland']), 'docent');
  assert.equal(removeLocationKeywords('docent wiskunde zuid-holland', ['Zuid-Holland']), 'docent wiskunde');
  assert.equal(removeLocationKeywords('intern begeleider, Den Haag', ['Den Haag']), 'intern begeleider');
  assert.equal(removeLocationKeywords('holland america line', ['Zuid-Holland']), 'holland america line', 'a partial overlap is not a location keyword');
  assert.equal(removeLocationKeywords('docent wiskunde', ['Zuid-Holland']), 'docent wiskunde');
  assert.equal(removeLocationKeywords('docent', []), 'docent');
  assert.equal(buildJobBoardSearchTerm({ branch: 'Onderwijs', keywords: removeLocationKeywords('zuid-holland', ['Zuid-Holland']) }), 'Onderwijs');
});

test('the provider reports what every board was asked and how many candidates were requested and returned', async () => {
  const { impl } = fakeScrape({
    indeed: () => envelope([job('indeed', 1), job('indeed', 2)], [siteMeta('indeed', 2)]),
    linkedin: () => envelope([job('linkedin', 1)], [siteMeta('linkedin', 1)]),
  });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Onderwijs', location: 'Zuid-Holland', country: 'netherlands', resultsWanted: 65, timeoutMs: 19_500 });
  const indeed = result.meta.find(meta => meta.site === 'indeed');
  const linkedin = result.meta.find(meta => meta.site === 'linkedin');
  assert.deepEqual({ ...indeed.query, timeoutMs: undefined }, { searchTerm: 'Onderwijs', location: 'Zuid-Holland', country: 'netherlands', resultsWanted: 65, timeoutMs: undefined });
  assert.deepEqual({ ...linkedin.query, timeoutMs: undefined }, { searchTerm: 'Onderwijs', location: 'Zuid-Holland, Netherlands', country: 'netherlands', resultsWanted: 30, timeoutMs: undefined });
  assert.equal(indeed.requestedCandidates, 65);
  assert.equal(indeed.returnedCandidates, 2);
  assert.equal(linkedin.requestedCandidates, 30, 'LinkedIn is capped to what it can deliver in one run');
  assert.equal(linkedin.returnedCandidates, 1);
  assert.ok(!JSON.stringify(result.meta).match(/cookie|authorization|proxy|password/i), 'no secrets or headers in the diagnostics');
});

test('both boards get the whole provider budget (it used to be halved, which cut LinkedIn off at ~9.5 s)', async () => {
  const { impl, calls } = fakeScrape({ indeed: () => envelope([], [siteMeta('indeed', 0)]), linkedin: () => envelope([], [siteMeta('linkedin', 0)]) });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 19_500 });
  for (const call of calls) assert.ok(call.timeoutMs >= 18_900 && call.timeoutMs <= 19_000, `timeoutMs ${call.timeoutMs}`);
  assert.ok(result.meta.every(meta => meta.query.timeoutMs >= 18_900));
});

test('a LinkedIn timeout keeps the Indeed results; the outcome is partial for LinkedIn only', async () => {
  const { impl } = fakeScrape({
    indeed: () => envelope([job('indeed', 1), job('indeed', 2)], [siteMeta('indeed', 2)]),
    linkedin: () => envelope([job('linkedin', 1)], [siteMeta('linkedin', 1, { status: 'partial', error: { name: 'Error', message: 'timed out after 9500ms (returned partial results)' } })]),
  });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 19_500 });
  assert.equal(result.candidates.filter(candidate => candidate.site === 'indeed').length, 2);
  assert.equal(result.candidates.filter(candidate => candidate.site === 'linkedin').length, 1);
  assert.equal(result.meta.find(meta => meta.site === 'indeed').status, 'ok');
  assert.equal(result.meta.find(meta => meta.site === 'linkedin').status, 'partial');
  assert.equal(result.meta.find(meta => meta.site === 'linkedin').errorType, 'timeout');
});

test('a board that never answers is cut off on its own; the other board still returns', async () => {
  const { impl } = fakeScrape({
    indeed: () => envelope([job('indeed', 1)], [siteMeta('indeed', 1)]),
    linkedin: () => new Promise(() => {}),
  });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const started = Date.now();
  const result = await provider.findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 600 });
  assert.ok(Date.now() - started < 4_500, 'bounded by the board timeout plus its grace period');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.meta.find(meta => meta.site === 'indeed').status, 'ok');
  const linkedin = result.meta.find(meta => meta.site === 'linkedin');
  assert.equal(linkedin.status, 'error');
  assert.equal(linkedin.errorType, 'timeout');
});

test('Indeed failing never touches LinkedIn, and LinkedIn 429 is rate_limited and never retried', async () => {
  const { impl, calls } = fakeScrape({
    indeed: () => { throw new Error('Indeed exploded'); },
    linkedin: () => { const error = new Error('LinkedIn responded with HTTP 429'); error.status = 429; throw error; },
  });
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: impl });
  const result = await provider.findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 19_500 });
  assert.equal(result.meta.find(meta => meta.site === 'linkedin').status, 'rate_limited');
  assert.equal(calls.filter(call => call.sites[0] === 'linkedin').length, 1, 'a 429 is never retried');
  assert.equal(result.meta.find(meta => meta.site === 'indeed').status, 'error');

  const other = fakeScrape({
    indeed: () => envelope([job('indeed', 1)], [siteMeta('indeed', 1)]),
    linkedin: () => { throw new Error('boom'); },
  });
  const survivors = await createTsJobSpySourceProvider({ scrapeJobsImpl: other.impl }).findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 19_500 });
  assert.equal(survivors.candidates.length, 1);
});

test('one retry for a transient failure with nothing returned and budget left; none when the budget is spent', async () => {
  let attempts = 0;
  const flaky = fakeScrape({
    indeed: () => envelope([], [siteMeta('indeed', 0)]),
    linkedin: () => { attempts++; if (attempts === 1) throw new Error('fetch failed: ECONNRESET'); return envelope([job('linkedin', 1)], [siteMeta('linkedin', 1)]); },
  });
  const recovered = await createTsJobSpySourceProvider({ scrapeJobsImpl: flaky.impl }).findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 19_500 });
  assert.equal(recovered.meta.find(meta => meta.site === 'linkedin').attempts, 2);
  assert.equal(recovered.candidates.filter(candidate => candidate.site === 'linkedin').length, 1);

  let tightAttempts = 0;
  const tight = fakeScrape({
    indeed: () => envelope([], [siteMeta('indeed', 0)]),
    linkedin: () => { tightAttempts++; throw new Error('fetch failed: ECONNRESET'); },
  });
  const failed = await createTsJobSpySourceProvider({ scrapeJobsImpl: tight.impl }).findCandidates({ query: 'Onderwijs', location: 'Nederland', timeoutMs: 3_000 });
  assert.equal(tightAttempts, 1, 'no retry when less than the minimum budget is left');
  assert.equal(failed.meta.find(meta => meta.site === 'linkedin').status, 'error');
});

test('Onderwijs + Zuid-Holland (relevance from 8830e5f is unchanged): an education job is accepted, an incidental mention is not', () => {
  const query = { branch: 'Onderwijs', keywords: null, region: 'Zuid-Holland' };
  const teacher = scoreVacancyRelevance({ title: 'Docent Nederlands', company: 'Dunamare onderwijsgroep', location: 'Den Haag', description: 'Onderwijs aan onze school, goed onderwijs. '.concat('woord '.repeat(60)) }, query);
  assert.equal(teacher.accepted, true);
  const carpenter = scoreVacancyRelevance({ title: 'Timmerman', company: 'KWS', location: 'Zwijndrecht', description: 'woord '.repeat(300).concat('Middelbaar onderwijs afgerond.') }, query);
  assert.equal(carpenter.accepted, false);
});

test('boundary case "Dyslexiebehandelaar": 6 mentions in 874 words is 0.69%, just under the 0.7% description threshold', () => {
  const query = { branch: 'Onderwijs', keywords: null, region: null };
  const words = count => Array.from({ length: count }, (_, i) => `woord${i}`);
  const description = mentions => [...Array(mentions).fill('onderwijs'), ...words(874 - mentions)].join(' ');
  const facts = mentions => ({ title: 'Dyslexiebehandelaar, min. 16 uur per week', company: 'Driestar educatief', location: 'Gouda', description: description(mentions) });
  const rejected = scoreVacancyRelevance(facts(6), query);
  assert.equal(rejected.accepted, false, 'currently rejected on density (6 / 874 = 0.686%)');
  assert.equal(rejected.acceptanceReason, 'rejected_weak_evidence');
  assert.equal(rejected.descriptionMatches.length, 1);
  const accepted = scoreVacancyRelevance(facts(7), query);
  assert.equal(accepted.accepted, true, '7 / 874 = 0.80% is accepted');
  assert.equal(accepted.acceptanceReason, 'description_content_match');
});
