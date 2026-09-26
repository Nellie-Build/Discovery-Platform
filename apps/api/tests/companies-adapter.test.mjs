import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createCompaniesAdapter } from '../dist/domains/companies-adapter.js';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';
import { SITES, SECURITY_RESULTS, VEILIG_ZUID, webTransport, fakeClock, fakeSearchProvider } from '../../../domains/companies/tests/fake-companies.mjs';

/**
 * Companies end to end: real adapter, real crawl engine and run persistence over in-memory company sites and a fake
 * search provider. No network. The module is enabled globally and granted to the test workspace, as an admin would.
 */
const runConfig = over => ({ targetRecords: 20, maxDurationMs: 120_000, ...over });
const CRITERIA = { products: ['camerasystemen'], services: ['installatie'], customerSectors: ['zorginstellingen'], provinces: ['Zuid-Holland'], maxQueries: 2, pagesPerCompany: 6 };

async function app({ sites = SITES, provider = fakeSearchProvider([['camera', SECURITY_RESULTS]]), grant = true } = {}) {
  const web = webTransport(sites);
  const adapter = createCompaniesAdapter({ web: { crawler: createDiscoveryCrawler('legacy'), transport: web.transport, clock: fakeClock(), searchProvider: provider } });
  const t = await startTestApp({ apiKey: 'test-key', domainRegistry: { companies: adapter } });
  await t.db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'companies'");
  const workspace = (await t.request('POST', '/workspaces', { body: { name: 'Companies test' } })).body;
  if (grant) await t.db.query("INSERT INTO workspace_modules (workspace_id, module_id, enabled) VALUES ($1, 'companies', true)", [workspace.id]);
  const project = grant ? (await t.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Beveiligers', domain: 'companies' } })).body : null;
  const start = async (body, projectId = project?.id) => (await t.request('POST', `/projects/${projectId}/runs`, { body })).body;
  const records = async () => (await t.request('GET', `/projects/${project.id}/records`)).body;
  return { ...t, web, provider, workspace, project, start, records };
}

test('route A: companies found by what they do, with evidence per criterion; non-companies and directories never become records', async () => {
  const t = await app();
  try {
    const run = await t.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    assert.equal(run.status, 'partial', 'one candidate site could not be read');
    assert.deepEqual(run.stats.incompleteReasons, ['1 website(s) konden niet worden gelezen']);
    assert.equal(run.recordsCreated, 2);
    assert.deepEqual(run.stats.byStatus, { confirmed: 1, possible: 1, insufficient: 0 });
    assert.deepEqual(run.stats.excludedResults, { directory: 2, social: 2 });
    assert.deepEqual(run.stats.notCompanySites, ['beveiligingsnieuws.example']);
    assert.equal(run.stats.criteriaSummary, 'Product: camerasystemen · Dienst: installatie · Afnemer: zorginstellingen · Zuid-Holland');
    const records = await t.records();
    const installer = records.find(r => r.domain_data.identity === 'veilig-zuid.example');
    assert.equal(installer.display_name, 'Veilig Zuid B.V.');
    assert.equal(installer.score, null, 'no quality or lead score');
    assert.equal(installer.domain_data.search.status, 'confirmed');
    const care = installer.domain_data.search.matches.find(m => m.kind === 'customer_sector');
    assert.deepEqual([care.status, care.sourceType], ['confirmed', 'official_website']);
    assert.match(care.sourceUrl, /\/sectoren$/);
    const shop = records.find(r => r.domain_data.identity === 'camerashop.example');
    assert.equal(shop.domain_data.search.status, 'possible');
    assert.notEqual(shop.domain_data.search.matches.find(m => m.kind === 'customer_sector').status, 'confirmed');
    const { rows } = await t.db.query("SELECT source_url FROM record_sources WHERE record_id = $1 ORDER BY source_url", [installer.id]);
    assert.ok(rows.length >= 4 && rows.every(r => r.source_url.startsWith('https://www.veilig-zuid.example/')));
  } finally { await t.close(); }
});

test('repeated runs: the same companies are unchanged (no duplicates); new information updates a company and keeps what was known', async () => {
  const sites = { ...SITES, 'www.veilig-zuid.example': { ...VEILIG_ZUID } };
  const t = await app({ sites });
  try {
    await t.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    const again = await t.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    assert.deepEqual([again.recordsCreated, again.recordsUpdated, again.stats.duplicatesUnchanged], [0, 0, 2]);
    assert.equal((await t.records()).length, 2);
    // The installer adds a monitoring room and removes its sector page; earlier evidence stays.
    sites['www.veilig-zuid.example']['/diensten'] = { body: VEILIG_ZUID['/diensten'].body.replace('</main>', '<h2>Alarmopvolging</h2><p>Eigen meldkamer voor alarmopvolging.</p></main>') };
    delete sites['www.veilig-zuid.example']['/sectoren'];
    const third = await t.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    assert.deepEqual([third.recordsCreated, third.recordsUpdated], [0, 1]);
    const installer = (await t.records()).find(r => r.domain_data.identity === 'veilig-zuid.example');
    assert.ok(installer.domain_data.services.some(s => s.conceptId === 'monitoring'));
    assert.ok(installer.domain_data.customerSectors.some(s => s.conceptId === 'care_institutions' && s.strength === 'strong'), 'verified evidence is not wiped by a website change');
    assert.equal((await t.records()).length, 2);
  } finally { await t.close(); }
});

test('route B: a direct company website is profiled whatever it matches; a description alone is interpreted on the server', async () => {
  const t = await app();
  try {
    const run = await t.start({ sourceUrl: 'https://www.delftse-bouw.example/', filters: { description: 'bouwbedrijven gespecialiseerd in renovatie van scholen in Zuid-Holland' }, runConfig: runConfig() });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.recordsCreated, 1);
    const [company] = await t.records();
    assert.equal(company.domain_data.name, 'Delftse Bouw B.V.');
    assert.equal(company.domain_data.search.matches.find(m => m.kind === 'specialisation').status, 'confirmed');
    assert.equal(company.domain_data.search.matches.find(m => m.kind === 'province').found, 'Vestiging in Delft');
    assert.equal(company.domain_data.registration.kvkNumber, null);
    assert.equal(company.domain_data.email, null, 'unknown stays unknown');
    const bad = await t.start({ sourceId: 'website', filters: { url: 'https://www.linkedin.com/company/x' }, runConfig: runConfig() });
    assert.equal(bad.status, 'failed');
    assert.match(bad.error, /geen bedrijfswebsite/);
  } finally { await t.close(); }
});

test('budgets and failures: a company limit makes the run partial; invalid criteria and a missing provider fail with a clear message', async () => {
  const t = await app();
  try {
    const small = await t.start({ sourceId: 'search', filters: { ...CRITERIA, maxCompanies: 1 }, runConfig: runConfig() });
    assert.equal(small.status, 'partial');
    assert.ok(small.stats.candidatesNotResearched >= 1);
    assert.equal(small.stats.companiesResearched, 1);
    const foreign = await t.start({ sourceId: 'search', filters: { ...CRITERIA, country: 'Duitsland' }, runConfig: runConfig() });
    assert.equal(foreign.status, 'failed');
    assert.match(foreign.error, /alleen naar bedrijven in Nederland/);
    const nothing = await t.start({ sourceId: 'search', filters: { provinces: ['Zuid-Holland'] }, runConfig: runConfig() });
    assert.match(nothing.error, /wat voor bedrijven/);
  } finally { await t.close(); }
  const noProvider = await app({ provider: null });
  try {
    const run = await noProvider.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /geen zoekprovider/);
  } finally { await noProvider.close(); }
});

test('module access: a workspace without Companies gets 403 on project creation and run start; existing data stays readable; other workspaces cannot read it', async () => {
  const t = await app();
  try {
    await t.start({ sourceId: 'search', filters: CRITERIA, runConfig: runConfig() });
    const blocked = (await t.request('POST', '/workspaces', { body: { name: 'Geen companies' } })).body;
    const refused = await t.request('POST', '/projects', { body: { workspaceId: blocked.id, name: 'X', domain: 'companies' } });
    assert.deepEqual([refused.status, refused.body.error], [403, 'module_not_enabled_for_workspace']);

    await t.db.query("UPDATE workspace_modules SET enabled = false WHERE workspace_id = $1 AND module_id = 'companies'", [t.workspace.id]);
    const run = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { sourceId: 'search', filters: CRITERIA } });
    assert.deepEqual([run.status, run.body.error], [403, 'module_not_enabled_for_workspace']);
    assert.equal((await t.records()).length, 2, 'existing companies stay readable');

    const outsider = t.createClient();
    await outsider.registerAndLogin(uniqueEmail());
    assert.notEqual((await outsider.request('GET', `/projects/${t.project.id}/records`)).status, 200);
  } finally { await t.close(); }
});

test('batches: a search that left candidates is continued from the run itself, without searching again, once, until nothing is left', async () => {
  const t = await app();
  try {
    const first = await t.start({ sourceId: 'search', filters: { ...CRITERIA, maxCompanies: 1 }, runConfig: runConfig() });
    assert.equal(first.status, 'partial');
    assert.ok(first.stats.continuation.remaining >= 2);
    assert.match(first.stats.incompleteReasons.join(' '), /wachten op een vervolgbatch/);
    const searches = t.provider.queries.length;
    const researched = [first.stats.companiesResearched];

    // The client sends only the run id; other criteria it sends are ignored (the earlier run's own request is used).
    const second = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: first.id, filters: { products: ['zonnepanelen'] } } });
    assert.equal(second.status, 201);
    assert.equal(second.body.stats.continuesRunId, first.id);
    assert.equal(second.body.stats.batch, 2);
    assert.equal(second.body.stats.continued, true);
    assert.deepEqual(second.body.stats.criteria.filters.products, ['camerasystemen']);
    assert.equal(t.provider.queries.length, searches, 'a continuation never searches again');
    researched.push(second.body.stats.companiesResearched + second.body.stats.sitesFailed.length);

    const again = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: first.id } });
    assert.deepEqual([again.status, again.body.error], [409, 'already_continued']);

    // Continue until the candidates run out; then there is nothing to continue.
    let last = second.body;
    for (let i = 0; i < 6 && last.stats.continuation; i++) {
      last = (await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: last.id } })).body;
    }
    assert.equal(last.stats.continuation, null);
    const done = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: last.id } });
    assert.deepEqual([done.status, done.body.error], [400, 'nothing_to_continue']);
    const records = await t.records();
    assert.equal(new Set(records.map(r => r.domain_data.identity)).size, records.length, 'batches never create duplicates');
    assert.ok(records.some(r => r.domain_data.identity === 'veilig-zuid.example'));
  } finally { await t.close(); }
});

test('batches are safe: an invalid id, another project\'s run and a switched-off module are refused', async () => {
  const t = await app();
  try {
    const first = await t.start({ sourceId: 'search', filters: { ...CRITERIA, maxCompanies: 1 }, runConfig: runConfig() });
    assert.equal((await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: 'x' } })).status, 400);
    const other = (await t.request('POST', '/projects', { body: { workspaceId: t.workspace.id, name: 'Ander project', domain: 'companies' } })).body;
    assert.equal((await t.request('POST', `/projects/${other.id}/runs`, { body: { continueFromRunId: first.id } })).status, 404);
    await t.db.query("UPDATE workspace_modules SET enabled = false WHERE workspace_id = $1 AND module_id = 'companies'", [t.workspace.id]);
    const blocked = await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: first.id } });
    assert.deepEqual([blocked.status, blocked.body.error], [403, 'module_not_enabled_for_workspace']);
  } finally { await t.close(); }
});

test('budgets per batch: every batch keeps the original run configuration and its own company and page limits', async () => {
  const t = await app();
  try {
    const first = await t.start({ sourceId: 'search', filters: { ...CRITERIA, maxCompanies: 1, pagesPerCompany: 2 }, runConfig: runConfig({ maxDurationMs: 60_000 }) });
    const batches = [first];
    for (let i = 0; i < 6 && batches.at(-1).stats.continuation; i++) {
      batches.push((await t.request('POST', `/projects/${t.project.id}/runs`, { body: { continueFromRunId: batches.at(-1).id, runConfig: { targetRecords: 200, maxDurationMs: 999_999 } } })).body);
    }
    assert.ok(batches.length >= 3, 'several batches ran');
    for (const batch of batches) {
      assert.deepEqual(batch.stats.criteria.runConfig, first.stats.criteria.runConfig, 'a client cannot raise the budget of a batch');
      assert.equal(batch.stats.maxDurationMs, 60_000);
      assert.equal(batch.stats.maxCompanies, 1);
      assert.ok(batch.stats.companiesResearched + batch.stats.sitesFailed.length <= 1, `batch ${batch.stats.batch ?? 1} researched at most one company`);
      assert.ok(batch.stats.pagesVisited <= 2, `batch ${batch.stats.batch ?? 1} read at most two pages`);
    }
    const records = await t.records();
    assert.ok(records.every(r => r.domain_data.sources.length <= 2), 'no company profile was read beyond the page budget');
  } finally { await t.close(); }
});
