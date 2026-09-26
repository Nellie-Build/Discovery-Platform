import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { DiscoveryJobsRepository, DiscoveryRunsRepository } from '@discovery-platform/db';
import { createCompaniesAdapter } from '../dist/domains/companies-adapter.js';
import { createJobRunner, MAX_ATTEMPTS } from '../dist/jobs/job-runner.js';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';
import { SITES, SECURITY_RESULTS, webTransport, fakeClock, fakeSearchProvider } from '../../../domains/companies/tests/fake-companies.mjs';

/**
 * Extended processing: a companies search as a background job of bounded batches. The runner is driven with tick()
 * (no timers), over the real adapter, crawl engine and persistence on in-memory sites and a fake search provider.
 * The fake search finds four candidate companies (two directory/social results are never candidates).
 */
const REQUEST = { sourceId: 'search', filters: { products: ['camerasystemen'], services: ['installatie'], customerSectors: ['zorginstellingen'], provinces: ['Zuid-Holland'] }, runConfig: { maxDurationMs: 120_000 } };

async function app({ failWhen = () => false } = {}) {
  const web = webTransport(SITES);
  const provider = fakeSearchProvider([['camera', SECURITY_RESULTS]]);
  const real = createCompaniesAdapter({ web: { crawler: createDiscoveryCrawler('legacy'), transport: web.transport, clock: fakeClock(), searchProvider: provider } });
  let calls = 0;
  // A test seam: the adapter can be made to throw for chosen batches (a crash in the middle of a batch).
  const adapter = { ...real, async runDiscovery(input) { calls++; if (failWhen(calls, input)) throw new Error('boom'); return real.runDiscovery(input); } };
  // A module without background jobs (as vacancies and tenders are): its adapter does not declare them.
  const registry = { companies: adapter, vacancies: { id: 'vacancies', async runDiscovery() { return { records: [], stats: {} }; } } };
  const t = await startTestApp({ apiKey: 'test-key', domainRegistry: registry });
  await t.db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'companies'");
  const workspace = (await t.request('POST', '/workspaces', { body: { name: 'Companies jobs' } })).body;
  await t.db.query("INSERT INTO workspace_modules (workspace_id, module_id, enabled) VALUES ($1, 'companies', true)", [workspace.id]);
  const project = (await t.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Beveiligers', domain: 'companies' } })).body;
  const runner = (owner = 'worker-a') => createJobRunner(t.db, registry, { owner });
  const startJob = async (limits, request = REQUEST, projectId = project.id) => t.request('POST', `/projects/${projectId}/jobs`, { body: { request, limits } });
  const job = async id => (await t.request('GET', `/jobs/${id}`)).body;
  const records = async () => (await t.request('GET', `/projects/${project.id}/records`)).body;
  const drain = async (worker, max = 12) => { let n = 0; while (n < max && await worker.tick()) n++; return n; };
  return { ...t, provider, registry, workspace, project, runner, startJob, job, records, drain };
}

test('a job runs in the background in batches: one search, then continuations without new searches, results visible per batch, no duplicates', async () => {
  const t = await app();
  try {
    const started = await t.startJob({ maxCandidates: 10, batchSize: 1, pagesPerCompany: 3, maxSearchQueries: 2 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.status, 'queued');
    assert.deepEqual(started.body.limits, { maxCandidates: 10, batchSize: 1, pagesPerCompany: 3, maxSearchQueries: 2, maxBatches: 10 + MAX_ATTEMPTS });
    assert.equal(t.provider.queries.length, 0, 'starting a job returns at once; nothing has run yet');

    const worker = t.runner();
    assert.equal(await worker.tick(), true);
    const afterFirst = await t.job(started.body.id);
    assert.equal(afterFirst.status, 'queued', 'more candidates are waiting');
    assert.equal(afterFirst.usage.batches, 1);
    assert.equal(t.provider.queries.length, 2, 'the first batch searched, within the query limit');
    assert.ok((await t.records()).length <= 1, 'results of a finished batch are visible while the job goes on');

    await t.drain(worker);
    const done = await t.job(started.body.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.message, 'Alle gevonden kandidaten zijn onderzocht.');
    assert.equal(t.provider.queries.length, 2, 'continuations never search again');
    assert.equal(done.usage.searchQueries, 2);
    assert.equal(done.usage.candidatesResearched, 4);
    assert.equal(done.batches.length, done.usage.batches);
    assert.ok(done.batches.every(batch => batch.companiesResearched <= 1));
    const records = await t.records();
    assert.equal(new Set(records.map(r => r.domain_data.identity)).size, records.length, 'no duplicates');
    assert.ok(records.some(r => r.domain_data.identity === 'veilig-zuid.example'));
    assert.ok(records.every(r => r.domain_data.sources.length <= 3), 'the page limit per company holds in every batch');
    assert.equal(await worker.tick(), false, 'a completed job is never picked up again');
  } finally { await t.close(); }
});

test('the total candidate limit is hard across batches', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 2, batchSize: 1, maxSearchQueries: 1 });
    await t.drain(t.runner());
    const done = await t.job(body.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.usage.candidatesResearched, 2);
    assert.equal(done.message, 'Het maximum aantal kandidaten is onderzocht.');
    assert.ok(done.usage.candidatesRemaining > 0, 'the rest is reported, not researched');
    // A batch never researches more than the budget that is left.
    const big = await t.startJob({ maxCandidates: 3, batchSize: 10 });
    assert.equal(big.body.limits.batchSize, 3);
  } finally { await t.close(); }
});

test('one active job per project; a job-managed run cannot also be continued by hand; limits are clamped', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 999, batchSize: 99, pagesPerCompany: 99, maxSearchQueries: 99 });
    assert.deepEqual(body.limits, { maxCandidates: 100, batchSize: 10, pagesPerCompany: 12, maxSearchQueries: 12, maxBatches: 10 + MAX_ATTEMPTS });
    const second = await t.startJob({});
    assert.deepEqual([second.status, second.body.error], [409, 'job_active']);
    await t.db.query("UPDATE discovery_jobs SET limits = jsonb_set(jsonb_set(limits, '{batchSize}', '1'), '{maxSearchQueries}', '1') WHERE id = $1", [body.id]);
    await t.runner().tick();
    const firstRun = (await t.job(body.id)).batches[0];
    const manual = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: firstRun.runId } });
    assert.deepEqual([manual.status, manual.body.error], [409, 'job_managed']);
    // After a stop, the manual next-batch button works again, and a new job may be started.
    assert.equal((await t.request('POST', `/jobs/${body.id}/stop`)).body.status, 'stopped');
    assert.equal((await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: firstRun.runId } })).status, 201);
    assert.equal((await t.startJob({ maxCandidates: 1 })).status, 202);
  } finally { await t.close(); }
});

test('pause, resume and stop: a paused job is never picked up, a stopped job never restarts', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const worker = t.runner();
    await worker.tick();
    assert.equal((await t.request('POST', `/jobs/${body.id}/pause`)).body.status, 'paused');
    assert.equal(await worker.tick(), false);
    assert.equal((await t.job(body.id)).usage.batches, 1);
    assert.equal((await t.request('POST', `/jobs/${body.id}/resume`)).body.status, 'queued');
    assert.equal(await worker.tick(), true);
    assert.equal((await t.job(body.id)).usage.batches, 2);
    assert.equal((await t.request('POST', `/jobs/${body.id}/stop`)).body.status, 'stopped');
    assert.equal(await worker.tick(), false);
    const resume = await t.request('POST', `/jobs/${body.id}/resume`);
    assert.deepEqual([resume.status, resume.body.error], [409, 'invalid_job_state']);
    assert.equal(t.provider.queries.length, 1, 'no search after the first batch');
  } finally { await t.close(); }
});

test('a pause or stop requested while a batch runs takes effect when that batch is done', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const jobs = new DiscoveryJobsRepository(t.db);
    // The worker holds the job (as during a batch) when the user stops it.
    const claimed = await jobs.claimNext('worker-a', 60_000);
    assert.equal((await t.request('POST', `/jobs/${body.id}/stop`)).body.status, 'stopping');
    const released = await jobs.release(claimed.id, 'worker-a', { next: 'queued', usage: {}, lastRunId: null });
    assert.equal(released.status, 'stopped');
    const other = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const again = await jobs.claimNext('worker-a', 60_000);
    assert.equal(again.id, other.body.id);
    assert.equal((await t.request('POST', `/jobs/${other.body.id}/pause`)).body.status, 'paused');
    assert.equal((await jobs.release(again.id, 'worker-a', { next: 'queued', usage: {} })).status, 'paused', 'the pause wins over the worker queueing the next batch');
    // A worker that lost the job (another owner) cannot change it.
    assert.equal(await jobs.release(again.id, 'worker-b', { next: 'completed', usage: {} }), null);
  } finally { await t.close(); }
});

test('two workers never run the same job at once', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const results = await Promise.all([t.runner('worker-a').tick(), t.runner('worker-b').tick()]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await t.job(body.id)).batches.length, 1, 'exactly one batch ran');
  } finally { await t.close(); }
});

test('a server restart during a follow-up batch: the batch is marked failed and the job continues from the last finished batch, without searching again or duplicating', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    await t.runner().tick();
    const jobs = new DiscoveryJobsRepository(t.db);
    const runs = new DiscoveryRunsRepository(t.db);
    // A worker claims batch 2, creates its run and dies: the lease runs out.
    const claimed = await jobs.claimNext('dead-worker', 60_000);
    const orphan = await runs.createRun(t.project.id, { jobId: body.id, batch: 2 });
    await jobs.setCurrentRun(claimed.id, 'dead-worker', orphan.id);
    assert.equal(await t.runner('worker-b').tick(), false, 'a held lease is respected');
    await t.db.query("UPDATE discovery_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [body.id]);

    await t.drain(t.runner('worker-b'));
    assert.equal((await runs.getRunById(orphan.id)).status, 'failed');
    const done = await t.job(body.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.usage.batchesFailed, 1);
    assert.equal(done.usage.candidatesResearched, 4, 'no candidate was lost');
    assert.equal(t.provider.queries.length, 1, 'the restart never searched again');
    const records = await t.records();
    assert.equal(new Set(records.map(r => r.domain_data.identity)).size, records.length);
  } finally { await t.close(); }
});

test('a restart during the first (searching) batch pauses the job instead of searching again by itself', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const jobs = new DiscoveryJobsRepository(t.db);
    const runs = new DiscoveryRunsRepository(t.db);
    const claimed = await jobs.claimNext('dead-worker', 60_000);
    const orphan = await runs.createRun(t.project.id, { jobId: body.id, batch: 1 });
    await jobs.setCurrentRun(claimed.id, 'dead-worker', orphan.id);
    await t.db.query("UPDATE discovery_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [body.id]);
    await t.runner().tick();
    const paused = await t.job(body.id);
    assert.equal(paused.status, 'paused');
    assert.match(paused.message, /Hervat om opnieuw te zoeken/);
    assert.equal(t.provider.queries.length, 0);
    assert.equal(await t.runner().tick(), false);
    // Only the user's resume searches again.
    await t.request('POST', `/jobs/${body.id}/resume`);
    await t.runner().tick();
    assert.equal(t.provider.queries.length, 1);
  } finally { await t.close(); }
});

test('a failed follow-up batch loses no candidates and is retried a bounded number of times', async () => {
  let failing = false;
  const t = await app({ failWhen: () => failing });
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const worker = t.runner();
    await worker.tick();
    failing = true;
    await worker.tick();
    const afterFailure = await t.job(body.id);
    assert.equal(afterFailure.status, 'queued');
    assert.equal(afterFailure.usage.batchesFailed, 1);
    assert.match(afterFailure.message, /Batch 2 mislukt/);
    failing = false;
    await t.drain(worker);
    const done = await t.job(body.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.usage.candidatesResearched, 4, 'the failed batch\'s candidates were researched on the retry');

    const second = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    await worker.tick();
    failing = true;
    const ticks = await t.drain(worker);
    assert.equal(ticks, MAX_ATTEMPTS, 'a batch that keeps failing is tried at most MAX_ATTEMPTS times');
    const failed = await t.job(second.body.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.usage.batchesFailed, MAX_ATTEMPTS);
  } finally { await t.close(); }
});

test('a failed first batch is not retried (a retry would search again)', async () => {
  const t = await app({ failWhen: calls => calls === 1 });
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1 });
    const worker = t.runner();
    await worker.tick();
    assert.equal((await t.job(body.id)).status, 'failed');
    assert.equal(await worker.tick(), false);
  } finally { await t.close(); }
});

test('isolation and access: other users see nothing; every batch checks the module, the project and the starter\'s membership', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 1, maxSearchQueries: 1 });
    const outsider = t.createClient();
    await outsider.registerAndLogin(uniqueEmail());
    assert.equal((await outsider.request('GET', `/jobs/${body.id}`)).status, 404);
    assert.equal((await outsider.request('POST', `/jobs/${body.id}/stop`)).status, 404);
    assert.equal((await outsider.request('GET', `/projects/${t.project.id}/jobs`)).status, 404);
    assert.equal((await outsider.request('POST', `/projects/${t.project.id}/jobs`, { body: { request: REQUEST } })).status, 404);

    // The module is switched off for the workspace: the next batch does not run.
    await t.db.query("UPDATE workspace_modules SET enabled = false WHERE workspace_id = $1 AND module_id = 'companies'", [t.workspace.id]);
    await t.runner().tick();
    const stopped = await t.job(body.id);
    assert.equal(stopped.status, 'stopped');
    assert.match(stopped.message, /module/);
    assert.equal(stopped.usage.batches, 0);
    assert.equal(t.provider.queries.length, 0);
    const refused = await t.startJob({});
    assert.deepEqual([refused.status, refused.body.error], [403, 'module_not_enabled_for_workspace']);

    // A user's job stops when that user leaves the workspace.
    await t.db.query("UPDATE workspace_modules SET enabled = true WHERE workspace_id = $1 AND module_id = 'companies'", [t.workspace.id]);
    const member = t.createClient();
    const user = await member.registerAndLogin(uniqueEmail());
    await t.db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [t.workspace.id, user.id ?? user.user?.id]);
    const own = await member.request('POST', `/projects/${t.project.id}/jobs`, { body: { request: REQUEST, limits: { maxSearchQueries: 1 } } });
    assert.equal(own.status, 202, JSON.stringify(own.body));
    await t.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [t.workspace.id, user.id ?? user.user?.id]);
    await t.runner().tick();
    assert.equal((await t.job(own.body.id)).status, 'stopped');
    assert.equal(t.provider.queries.length, 0);

    // A deleted project's job stops.
    const next = await t.startJob({ maxSearchQueries: 1 });
    await t.request('DELETE', `/projects/${t.project.id}`);
    await t.runner().tick();
    assert.equal((await new DiscoveryJobsRepository(t.db).getJobById(next.body.id)).status, 'stopped');
  } finally { await t.close(); }
});

test('only a search can be a job, only in a module that supports jobs; the request is validated up front', async () => {
  const t = await app();
  try {
    const website = await t.startJob({}, { sourceUrl: 'https://www.veilig-zuid.example/' });
    assert.deepEqual([website.status, website.body.error], [400, 'invalid_request']);
    const empty = await t.startJob({}, { sourceId: 'search', filters: {} });
    assert.deepEqual([empty.status, empty.body.error], [400, 'invalid_request']);
    assert.equal((await t.request('POST', `/projects/${t.project.id}/jobs`, { body: {} })).status, 400);
    const vacancies = (await t.request('POST', '/projects', { body: { workspaceId: t.workspace.id, name: 'Vacatures', domain: 'vacancies' } })).body;
    assert.ok(vacancies.id, JSON.stringify(vacancies));
    const refused = await t.startJob({}, REQUEST, vacancies.id);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'jobs_not_supported');
    assert.equal((await new DiscoveryJobsRepository(t.db).listJobsByProject(t.project.id)).length, 0);
  } finally { await t.close(); }
});

test('CSV export: workspace isolation, filtered or all, a row limit, and never another project\'s records', async () => {
  const t = await app();
  try {
    const { body } = await t.startJob({ maxCandidates: 10, batchSize: 5, maxSearchQueries: 1 });
    await t.drain(t.runner());
    assert.equal((await t.job(body.id)).status, 'completed');
    const records = await t.records();
    assert.ok(records.length >= 2);
    const res = await fetch(`${t.baseUrl}/projects/${t.project.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="bedrijven-\d{4}-\d{2}-\d{2}\.csv"/);
    const all = await res.text();
    assert.equal(all.trim().split('\r\n').length, records.length + 1);
    assert.doesNotMatch(all, /mailto|@veilig-zuid|jan\.jansen/);

    const filtered = await (await fetch(`${t.baseUrl}/projects/${t.project.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' }, body: JSON.stringify({ recordIds: [records[0].id, '00000000-0000-4000-8000-000000000000'] }) })).text();
    assert.equal(filtered.trim().split('\r\n').length, 2, 'only the listed record of this project');

    assert.equal((await t.request('POST', `/projects/${t.project.id}/export`, { body: { recordIds: ['x'] } })).status, 400);
    const outsider = t.createClient();
    await outsider.registerAndLogin(uniqueEmail());
    assert.equal((await outsider.request('POST', `/projects/${t.project.id}/export`, { body: {} })).status, 404);
    const vacancies = (await t.request('POST', '/projects', { body: { workspaceId: t.workspace.id, name: 'Vacatures', domain: 'vacancies' } })).body;
    assert.equal((await t.request('POST', `/projects/${vacancies.id}/export`, { body: {} })).body.error, 'export_not_supported');
  } finally { await t.close(); }
});
