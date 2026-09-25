import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

/**
 * Module packages (migrations/009_module_packages.sql) through the API: an admin picks a package per workspace, can
 * deviate per module, the global switch always wins, and the existing gate keeps refusing project creation and run
 * starts the workspace may not use, while projects, runs and records made earlier stay readable.
 */
async function setup() {
  const app = await startTestApp();
  const register = async client => (await client.request('POST', '/auth/register', { body: { email: uniqueEmail(), password: 'a-secure-password-123' } })).body;
  const admin = app.createClient();
  const { user } = await register(admin);
  await app.db.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
  assert.equal((await admin.request('PATCH', '/admin/modules/tenders', { body: { enabled: true } })).status, 200);
  const owner = async () => { const client = app.createClient(); const { workspace } = await register(client); return { client, id: workspace.id }; };
  const setPackage = (id, packageId) => admin.request('PUT', `/admin/workspaces/${id}/package`, { body: { packageId } });
  const setModule = (id, moduleId, enabled) => admin.request('PUT', `/admin/workspaces/${id}/modules/${moduleId}`, { body: { enabled } });
  const overview = async id => (await admin.request('GET', '/admin/workspace-modules')).body.find(w => w.workspace_id === id);
  const available = async (client, id) => Object.fromEntries((await client.request('GET', `/workspaces/${id}/modules`)).body
    .filter(m => ['vacancies', 'tenders'].includes(m.module_id)).map(m => [m.module_id, m.enabled]));
  const create = (client, id, domain) => client.request('POST', '/projects', { body: { workspaceId: id, name: `P ${domain}`, domain } });
  return { ...app, admin, owner, setPackage, setModule, overview, available, create };
}

test('the four packages: what each makes available, and the API refuses the rest', async () => {
  const t = await setup();
  try {
    const list = await t.admin.request('GET', '/admin/module-packages');
    assert.deepEqual(list.body.map(p => [p.id, p.name, p.module_ids]), [['vacancies', 'Vacancies', ['vacancies']], ['tenders', 'Tenders', ['tenders']], ['complete', 'Compleet', ['tenders', 'vacancies']], ['custom', 'Maatwerk', []]]);
    // A new workspace starts on Compleet; switching it to Maatwerk keeps what it had, as individual choices.
    const expected = { vacancies: { tenders: false, vacancies: true }, tenders: { tenders: true, vacancies: false }, complete: { tenders: true, vacancies: true }, custom: { tenders: true, vacancies: true } };
    for (const [packageId, access] of Object.entries(expected)) {
      const { client, id } = await t.owner();
      assert.equal((await t.setPackage(id, packageId)).status, 200);
      assert.deepEqual(await t.available(client, id), access, packageId);
      const row = await t.overview(id);
      assert.equal(row.package_id, packageId);
      assert.equal(row.customized, false);
      for (const domain of ['vacancies', 'tenders']) {
        const res = await t.create(client, id, domain);
        assert.equal(res.status, access[domain] ? 201 : 403, `${packageId}/${domain}`);
        if (!access[domain]) assert.equal(res.body.error, 'module_not_enabled_for_workspace');
      }
    }
  } finally { await t.close(); }
});

test('a new workspace starts on Compleet; Maatwerk is set module by module', async () => {
  const t = await setup();
  try {
    const { client, id } = await t.owner();
    assert.equal((await t.overview(id)).package_id, 'complete');
    await t.setPackage(id, 'custom');
    assert.deepEqual(await t.available(client, id), { tenders: true, vacancies: true }, 'switching to Maatwerk keeps what the workspace had');
    await t.setModule(id, 'vacancies', false);
    assert.deepEqual(await t.available(client, id), { tenders: true, vacancies: false });
    const row = await t.overview(id);
    assert.equal(row.customized, false, 'in Maatwerk every choice is individual, not a deviation');
    assert.equal((await t.create(client, id, 'vacancies')).status, 403);
    assert.equal((await t.create(client, id, 'tenders')).status, 201);
  } finally { await t.close(); }
});

test('Compleet with Tenders switched off is marked as adjusted; clearing the choice or picking a package again resets it', async () => {
  const t = await setup();
  try {
    const { client, id } = await t.owner();
    await t.setPackage(id, 'complete');
    const off = await t.setModule(id, 'tenders', false);
    assert.deepEqual({ included: off.body.package_included, choice: off.body.workspace_enabled, deviates: off.body.deviates, enabled: off.body.enabled }, { included: true, choice: false, deviates: true, enabled: false });
    let row = await t.overview(id);
    assert.equal(row.package_id, 'complete');
    assert.equal(row.customized, true);
    assert.equal((await t.create(client, id, 'tenders')).status, 403);

    await t.setModule(id, 'tenders', null);
    assert.equal((await t.overview(id)).customized, false);
    await t.setModule(id, 'vacancies', false);
    await t.setPackage(id, 'complete');
    row = await t.overview(id);
    assert.equal(row.customized, false, 'picking a package starts clean from that package');
    assert.deepEqual(await t.available(client, id), { tenders: true, vacancies: true });
  } finally { await t.close(); }
});

test('the global switch always wins over package and individual choice', async () => {
  const t = await setup();
  try {
    const { client, id } = await t.owner();
    await t.setPackage(id, 'tenders');
    await t.setModule(id, 'tenders', true);
    await t.admin.request('PATCH', '/admin/modules/tenders', { body: { enabled: false } });
    assert.deepEqual(await t.available(client, id), { tenders: false, vacancies: false });
    const res = await t.create(client, id, 'tenders');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'module_disabled');
  } finally { await t.close(); }
});

test('changing the package blocks new runs of a module that is no longer included, and keeps its history readable', async () => {
  const t = await setup();
  try {
    const { client, id } = await t.owner();
    const project = (await t.create(client, id, 'vacancies')).body;
    await t.db.query(`INSERT INTO discovery_records (project_id, domain, display_name) VALUES ($1, 'vacancies', 'Historische vacature')`, [project.id]);
    await t.db.query(`INSERT INTO discovery_runs (project_id, status) VALUES ($1, 'succeeded')`, [project.id]);
    await t.setPackage(id, 'tenders');

    const run = await client.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.status, 403);
    assert.equal(run.body.error, 'module_not_enabled_for_workspace');
    assert.equal((await client.request('GET', `/projects/${project.id}`)).status, 200);
    assert.deepEqual((await client.request('GET', `/projects/${project.id}/records`)).body.map(r => r.display_name), ['Historische vacature']);
    assert.equal((await client.request('GET', `/projects/${project.id}/runs`)).body.length, 1, 'the refused run was not created');
  } finally { await t.close(); }
});

test('package management is admin-only and validated', async () => {
  const t = await setup();
  try {
    const { client, id } = await t.owner();
    assert.equal((await client.request('GET', '/admin/module-packages')).status, 403);
    assert.equal((await client.request('PUT', `/admin/workspaces/${id}/package`, { body: { packageId: 'complete' } })).status, 403);
    assert.equal((await t.setPackage(id, 'bestaat-niet')).status, 404);
    assert.equal((await t.setPackage(id, '')).status, 400);
    assert.equal((await t.setPackage('00000000-0000-0000-0000-000000000000', 'complete')).status, 404);
  } finally { await t.close(); }
});
