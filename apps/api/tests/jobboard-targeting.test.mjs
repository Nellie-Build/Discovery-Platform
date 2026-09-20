import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';
import { startTestApp } from './helpers/test-app.mjs';

const meta = (site, jobs, extra = {}) => ({ provider: 'ts-jobspy', site, status: jobs ? 'ok' : 'empty', candidates: jobs, durationMs: 5, error: null, ...extra });
const candidate = (site, title, id, description = 'Onderwijs op onze school. Goed onderwijs voor iedereen.') => ({ site, sourceUrl: `https://example.com/${id}`, needsEnrichment: false,
  facts: { title, description, company: `School ${id}`, location: 'Den Haag', email: `${id}@example.com` } });

function recordingProvider(result) {
  const calls = [];
  return { calls, provider: { async findCandidates(query) { calls.push(query); return result; } } };
}
function branchInput(overrides = {}) {
  const { runConfig, ...rest } = overrides;
  return { mode: 'branch', branch: 'Onderwijs', country: 'Nederland', region: 'Zuid-Holland', keywords: null, existingRecords: [], filters: {},
    runConfig: { targetRecords: 50, searchBreadth: 'standard', maxPages: 25, maxCandidates: 500, maxDurationMs: 180_000, maxEnrichments: 30, onlyNewRecords: true, ...runConfig },
    ...rest };
}
const empty = { candidates: [], meta: [meta('indeed', 0), meta('linkedin', 0)] };

test('branch and location reach the job boards as separate parameters: searchTerm "Onderwijs", place "Zuid-Holland", country netherlands', async () => {
  const { provider, calls } = recordingProvider(empty);
  const outcome = await createVacanciesAdapter({ jobBoardProvider: provider }).runDiscovery(branchInput());
  assert.equal(calls[0].query, 'Onderwijs');
  assert.equal(calls[0].location, 'Zuid-Holland');
  assert.equal(calls[0].country, 'netherlands');
  assert.equal(outcome.stats.jobBoardSearchTerm, 'Onderwijs');
  assert.deepEqual(outcome.stats.searchLocation, { country: 'netherlands', countryLabel: 'Netherlands', place: 'Zuid-Holland' });
});

test('content keywords stay in the search term, the province never does, and a keyword repeating the location is removed', async () => {
  const { provider, calls } = recordingProvider(empty);
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider });
  await adapter.runDiscovery(branchInput({ keywords: 'voortgezet onderwijs, docent wiskunde' }));
  assert.equal(calls[0].query, 'Onderwijs voortgezet onderwijs, docent wiskunde');
  await adapter.runDiscovery(branchInput({ keywords: 'zuid-holland' }));
  assert.equal(calls[1].query, 'Onderwijs');
  await adapter.runDiscovery(branchInput({ keywords: 'intern begeleider Zuid-Holland' }));
  assert.equal(calls[2].query, 'Onderwijs intern begeleider');
  for (const call of calls) assert.ok(!/holland/i.test(call.query));
});

test('older runs keep working: a single free-text region is still the country ("Nederland") or the place ("Den Haag")', async () => {
  const { provider, calls } = recordingProvider(empty);
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider });
  await adapter.runDiscovery(branchInput({ country: undefined, region: 'Nederland' }));
  assert.equal(calls[0].location, null);
  assert.equal(calls[0].country, 'netherlands');
  await adapter.runDiscovery(branchInput({ country: undefined, region: 'Den Haag' }));
  assert.equal(calls[1].location, 'Den Haag');
  assert.equal(calls[1].country, null);
});

test('the provider budget is the target plus 30%, not the whole target again per provider', async () => {
  const { provider, calls } = recordingProvider(empty);
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider });
  await adapter.runDiscovery(branchInput({ runConfig: { targetRecords: 50 } }));
  assert.equal(calls[0].resultsWanted, 65);
  await adapter.runDiscovery(branchInput({ runConfig: { targetRecords: 10 } }));
  assert.equal(calls[1].resultsWanted, 13);
  await adapter.runDiscovery(branchInput({ runConfig: { targetRecords: 500 } }));
  assert.equal(calls[2].resultsWanted, 500 , 'the provider itself caps this per job board');
});

test('one run keeps Indeed results when LinkedIn fails, and reports requested/returned per provider', async () => {
  const indeedQuery = { searchTerm: 'Onderwijs', location: 'Zuid-Holland', country: 'netherlands', resultsWanted: 65, timeoutMs: 19_500 };
  const result = {
    candidates: [candidate('indeed', 'Docent Wiskunde', 'a'), candidate('indeed', 'Leerkracht groep 6', 'b')],
    meta: [
      meta('indeed', 2, { query: indeedQuery, requestedCandidates: 65, returnedCandidates: 2 }),
      { provider: 'ts-jobspy', site: 'linkedin', status: 'rate_limited', errorType: 'rate_limited', candidates: 0, durationMs: 5, error: 'HTTP 429: bron tijdelijk begrensd.',
        query: { ...indeedQuery, location: 'Zuid-Holland, Netherlands', resultsWanted: 30 }, requestedCandidates: 30, returnedCandidates: 0 },
    ],
  };
  const outcome = await createVacanciesAdapter({ jobBoardProvider: recordingProvider(result).provider }).runDiscovery(branchInput());
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.records.length, 2);
  const indeed = outcome.stats.sources.find(source => source.site === 'indeed');
  const linkedin = outcome.stats.sources.find(source => source.site === 'linkedin');
  assert.equal(indeed.requestedCandidates, 65);
  assert.equal(indeed.returnedCandidates, 2);
  assert.equal(linkedin.status, 'rate_limited');
  assert.equal(linkedin.query.location, 'Zuid-Holland, Netherlands');
  assert.equal(outcome.stats.stopReason, 'source_rate_limited');
});

test('the run breakdown still adds up with the new query targeting (per provider and in total)', async () => {
  const result = { candidates: [candidate('indeed', 'Docent Wiskunde', 'a'), candidate('indeed', 'Timmerman', 'c', 'Timmerman werk'), candidate('linkedin', 'Leerkracht', 'b')],
    meta: [meta('indeed', 2), meta('linkedin', 1)] };
  const outcome = await createVacanciesAdapter({ jobBoardProvider: recordingProvider(result).provider }).runDiscovery(branchInput());
  const breakdown = outcome.stats.breakdown;
  const keys = ['notProcessed', 'noUsableData', 'rejectedByRelevance', 'rejectedByDate', 'duplicatesInRun', 'alreadyKnown', 'cutByTarget', 'newRecords'];
  assert.equal(breakdown.discovered, keys.reduce((sum, key) => sum + breakdown[key], 0));
  assert.equal(breakdown.newRecords, 2);
  assert.equal(breakdown.rejectedByRelevance, 1);
});

test('through the API: the run stores the country and region separately and the run card can show them', async () => {
  const { provider } = recordingProvider(empty);
  const app = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: provider });
  try {
    const workspace = (await app.request('POST', '/workspaces', { body: { name: 'Targeting' } })).body;
    const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Security Agencies', domain: 'vacancies' } })).body;
    const run = (await app.request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Onderwijs', country: 'Nederland', region: 'Zuid-Holland', runConfig: { targetRecords: 50 } } })).body;
    assert.equal(run.stats.criteria.country, 'Nederland');
    assert.equal(run.stats.criteria.region, 'Zuid-Holland');
    assert.equal(run.stats.jobBoardSearchTerm, 'Onderwijs');
    const legacy = (await app.request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Onderwijs', region: 'Nederland', runConfig: { targetRecords: 50 } } })).body;
    assert.equal(legacy.stats.criteria.country, null);
    assert.equal(legacy.stats.criteria.region, 'Nederland');
  } finally { await app.close(); }
});
