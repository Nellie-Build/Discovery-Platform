import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTendersAdapter } from '../dist/domains/tenders-adapter.js';
import { startTestApp, html } from './helpers/test-app.mjs';

/**
 * The generic follow-up-batch support in routes/runs.ts leaves the other modules exactly as they were: a Vacancies or
 * Tenders run stores no continuation, and asking to continue one is refused without starting a run.
 */
const vacancyPage = title => `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title, hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Utrecht' } } })}</script></head><body></body></html>`;

async function assertNotContinuable(request, project, run) {
  assert.ok(!('continuation' in run.stats), 'the run stores no continuation');
  assert.ok(!('continuesRunId' in run.stats) && !('batch' in run.stats));
  const before = (await request('GET', `/projects/${project.id}/runs`)).body.length;
  const refused = await request('POST', `/projects/${project.id}/runs`, { body: { continueFromRunId: run.id } });
  assert.deepEqual([refused.status, refused.body.error], [400, 'nothing_to_continue']);
  assert.equal((await request('GET', `/projects/${project.id}/runs`)).body.length, before, 'no run was started');
}

test('vacancies: a normal run is unchanged by batch support and cannot be continued', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/': { body: html([['/vacatures/developer', 'Vacatures']]) },
    '/vacatures/developer': { body: vacancyPage('Developer') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'V', domain: 'vacancies' } })).body;
    const run = (await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } })).body;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.recordsCreated, 1);
    await assertNotContinuable(request, project, run);
  } finally { await close(); }
});

test('tenders: a source run is unchanged by batch support and cannot be continued', async () => {
  const empty = () => ({ id: 'tenderned', kind: 'api', stats: () => ({}), async fetchBatch() { return { items: [], nextCursor: null, exhausted: true }; } });
  const adapter = createTendersAdapter({ sources: { tenderned: empty } });
  const { request, close, db } = await startTestApp({ apiKey: 'test-key', domainRegistry: { tenders: adapter } });
  try {
    await db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'tenders'");
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'T', domain: 'tenders' } })).body;
    const run = (await request('POST', `/projects/${project.id}/runs`, { body: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } } })).body;
    assert.equal(run.status, 'succeeded', run.error);
    await assertNotContinuable(request, project, run);
  } finally { await close(); }
});
