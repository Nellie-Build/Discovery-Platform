import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './helpers/test-app.mjs';

const meta = (site, status) => ({ provider: 'ts-jobspy', site, status, candidates: status === 'ok' ? 1 : 0, durationMs: 5, error: status === 'error' ? 'Failure' : null });
const candidate = (title, id) => ({ sourceUrl: `https://example.com/${id}`, needsEnrichment: false,
  facts: { title, description: title, company: 'Acme', location: 'Nederland', email: 'jobs@example.com' } });

test('provider outcomes, run criteria and result provenance remain isolated across searches', async () => {
  let result = { candidates: [], meta: [meta('indeed', 'error'), meta('linkedin', 'error')] };
  const queries = [];
  const app = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: { async findCandidates(query) { queries.push(query); return result; } } });
  try {
    const workspace = (await app.request('POST', '/workspaces', { body: { name: 'Quality test' } })).body;
    const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Security Agencies', domain: 'vacancies' } })).body;
    const run = async (branch, extra = {}) => (await app.request('POST', `/projects/${project.id}/runs`, { body: { branch, region: 'Nederland', runConfig: { targetRecords: 50 }, ...extra } })).body;
    const failed = await run('Onderwijs');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.stats.stopReason, 'all_sources_failed');
    assert.equal(failed.stats.sourcesFailed, 2);
    assert.equal(failed.stats.criteria.branch, 'Onderwijs');
    assert.equal(queries[0].query, 'Onderwijs');
    assert.ok(failed.stats.sources.some(s => s.status === 'not_configured'));

    result = { candidates: [candidate('Docent Onderwijs', 'teacher')], meta: [meta('indeed', 'ok'), meta('linkedin', 'error')] };
    const education = await run('Onderwijs');
    assert.equal(education.status, 'partial');
    assert.equal(education.recordsCreated, 1);
    result = { candidates: [candidate('Security Officer', 'guard'), candidate('Docent Onderwijs', 'teacher')], meta: [meta('indeed', 'ok'), meta('linkedin', 'empty')] };
    const security = await run('Security', { keywords: 'security officer beveiliging' });
    assert.equal(security.status, 'succeeded');
    assert.equal(security.stats.stopReason, 'provider_exhausted');
    assert.equal(security.stats.candidatesRejectedByRelevance, 1);
    assert.equal(security.recordsCreated, 1);
    const current = (await app.request('GET', `/projects/${project.id}/records?runId=${security.id}`)).body;
    assert.equal(current.length, 1);
    assert.equal(current[0].display_name, 'Security Officer');
    assert.deepEqual(current[0].classification.relevance.titleMatches, ['security', 'officer']);
    const historical = (await app.request('GET', `/projects/${project.id}/records?runId=${education.id}`)).body;
    assert.equal(historical[0].display_name, 'Docent Onderwijs');
    assert.equal((await app.request('GET', `/projects/${project.id}/records?runId=${failed.id}`)).body.length, 0);
    assert.equal((await app.request('GET', `/projects/${project.id}/records`)).body.length, 2);
    const repeat = await run('Security', { runConfig: { targetRecords: 50, onlyNewRecords: false } });
    assert.equal(repeat.recordsCreated, 0);
    assert.equal((await app.request('GET', `/projects/${project.id}/records?runId=${repeat.id}`)).body.length, 1);
    assert.equal((await app.request('GET', `/projects/${project.id}/records`)).body.length, 2);

    result = { candidates: [], meta: [meta('indeed', 'empty'), meta('linkedin', 'empty')] };
    const empty = await run('Security');
    assert.equal(empty.status, 'succeeded');
    assert.equal(empty.stats.stopReason, 'no_results');
    const disabled = await run('Security', { filters: { sources: [] } });
    assert.equal(disabled.status, 'failed');
    assert.equal(disabled.stats.stopReason, 'source_unavailable');
  } finally { await app.close(); }
});
