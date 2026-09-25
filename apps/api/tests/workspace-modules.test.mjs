import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

/**
 * Per-workspace module access (migrations/008_workspace_modules.sql, apps/api/src/module-registry.ts): the global
 * switch stays the master switch, a workspace without its own decision keeps the access it had, and a module
 * switched off for one workspace is refused by the API itself (project creation and run start) while that
 * workspace's existing projects and records stay readable.
 */
async function registerNewUser(client) {
  const res = await client.request('POST', '/auth/register', { body: { email: uniqueEmail(), password: 'a-secure-password-123' } });
  return { user: res.body.user, workspace: res.body.workspace };
}

async function setup() {
  const app = await startTestApp();
  const admin = app.createClient();
  const { user } = await registerNewUser(admin);
  await app.db.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
  // Tenders is seeded disabled (007_tenders_module.sql); the platform turns it on globally.
  assert.equal((await admin.request('PATCH', '/admin/modules/tenders', { body: { enabled: true } })).status, 200);
  const owner = async () => { const client = app.createClient(); const { workspace } = await registerNewUser(client); return { client, workspace }; };
  const setAccess = (workspaceId, moduleId, enabled) => admin.request('PUT', `/admin/workspaces/${workspaceId}/modules/${moduleId}`, { body: { enabled } });
  const createProject = (client, workspaceId, domain) => client.request('POST', '/projects', { body: { workspaceId, name: `P ${domain}`, domain } });
  return { ...app, admin, owner, setAccess, createProject };
}

test('a workspace without its own decision keeps exactly the global access', async () => {
  const t = await setup();
  try {
    const { client, workspace } = await t.owner();
    const available = await client.request('GET', `/workspaces/${workspace.id}/modules`);
    assert.equal(available.status, 200);
    const enabled = Object.fromEntries(available.body.map(m => [m.module_id, m.enabled]));
    assert.deepEqual(enabled, { candidates: false, companies: false, housing: false, tenders: true, vacancies: true });
    assert.equal((await t.createProject(client, workspace.id, 'vacancies')).status, 201);
    assert.equal((await t.createProject(client, workspace.id, 'tenders')).status, 201);
    const { rows } = await t.db.query('SELECT count(*)::int AS n FROM workspace_modules');
    assert.equal(rows[0].n, 0, 'no decision is stored for a workspace nobody configured');
  } finally { await t.close(); }
});

test('only Vacancies, only Tenders or both: the API refuses a module that is off for that workspace', async () => {
  const t = await setup();
  try {
    const onlyVacancies = await t.owner();
    const onlyTenders = await t.owner();
    const both = await t.owner();
    assert.equal((await t.setAccess(onlyVacancies.workspace.id, 'tenders', false)).status, 200);
    const switched = await t.setAccess(onlyTenders.workspace.id, 'vacancies', false);
    assert.deepEqual({ global: switched.body.global_enabled, workspace: switched.body.workspace_enabled, enabled: switched.body.enabled }, { global: true, workspace: false, enabled: false });

    const refused = await t.createProject(onlyVacancies.client, onlyVacancies.workspace.id, 'tenders');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'module_not_enabled_for_workspace');
    assert.equal((await t.createProject(onlyVacancies.client, onlyVacancies.workspace.id, 'vacancies')).status, 201);
    assert.equal((await t.createProject(onlyTenders.client, onlyTenders.workspace.id, 'vacancies')).status, 403);
    assert.equal((await t.createProject(onlyTenders.client, onlyTenders.workspace.id, 'tenders')).status, 201);
    assert.equal((await t.createProject(both.client, both.workspace.id, 'vacancies')).status, 201);
    assert.equal((await t.createProject(both.client, both.workspace.id, 'tenders')).status, 201);
  } finally { await t.close(); }
});

test('switching a module off for a workspace blocks new runs there, keeps its projects and records readable, and leaves other workspaces alone', async () => {
  const t = await setup();
  try {
    const a = await t.owner();
    const b = await t.owner();
    const project = (await t.createProject(a.client, a.workspace.id, 'vacancies')).body;
    const other = (await t.createProject(b.client, b.workspace.id, 'vacancies')).body;
    await t.db.query(`INSERT INTO discovery_records (project_id, domain, display_name) VALUES ($1, 'vacancies', 'Bestaande vacature')`, [project.id]);

    await t.setAccess(a.workspace.id, 'vacancies', false);
    const run = await a.client.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.status, 403);
    assert.equal(run.body.error, 'module_not_enabled_for_workspace');
    const { rows } = await t.db.query('SELECT count(*)::int AS n FROM discovery_runs WHERE project_id = $1', [project.id]);
    assert.equal(rows[0].n, 0, 'a refused run is never created');

    assert.equal((await a.client.request('GET', `/projects/${project.id}`)).status, 200);
    const records = await a.client.request('GET', `/projects/${project.id}/records`);
    assert.equal(records.status, 200);
    assert.deepEqual(records.body.map(r => r.display_name), ['Bestaande vacature']);
    assert.ok((await a.client.request('GET', `/projects?workspaceId=${a.workspace.id}`)).body.some(p => p.id === project.id));

    const otherWorkspace = await t.db.query('SELECT enabled FROM workspace_modules WHERE workspace_id = $1', [b.workspace.id]);
    assert.equal(otherWorkspace.rows.length, 0);
    assert.equal((await t.createProject(b.client, b.workspace.id, 'vacancies')).status, 201, 'another workspace is not affected');
    assert.ok(other.id);
  } finally { await t.close(); }
});

test('the global switch stays the master switch; clearing a workspace decision restores the default', async () => {
  const t = await setup();
  try {
    const { client, workspace } = await t.owner();
    await t.setAccess(workspace.id, 'tenders', true);
    await t.admin.request('PATCH', '/admin/modules/tenders', { body: { enabled: false } });
    const blocked = await t.createProject(client, workspace.id, 'tenders');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'module_disabled', 'globally off wins over a workspace that has it on');

    await t.admin.request('PATCH', '/admin/modules/tenders', { body: { enabled: true } });
    await t.setAccess(workspace.id, 'tenders', false);
    assert.equal((await t.createProject(client, workspace.id, 'tenders')).status, 403);
    const cleared = await t.setAccess(workspace.id, 'tenders', null);
    assert.equal(cleared.body.workspace_enabled, null);
    assert.equal(cleared.body.enabled, true);
    assert.equal((await t.createProject(client, workspace.id, 'tenders')).status, 201);
  } finally { await t.close(); }
});

test('admin-only and validated: non-admins get 403, unknown ids 404, a bad value 400; members see only their own workspace', async () => {
  const t = await setup();
  try {
    const a = await t.owner();
    const b = await t.owner();
    assert.equal((await a.client.request('GET', '/admin/workspace-modules')).status, 403);
    assert.equal((await a.client.request('PUT', `/admin/workspaces/${a.workspace.id}/modules/tenders`, { body: { enabled: true } })).status, 403);
    assert.notEqual((await a.client.request('GET', `/workspaces/${b.workspace.id}/modules`)).status, 200);

    assert.equal((await t.setAccess(a.workspace.id, 'nope', false)).status, 404);
    assert.equal((await t.setAccess('00000000-0000-0000-0000-000000000000', 'tenders', false)).status, 404);
    assert.equal((await t.setAccess('not-a-uuid', 'tenders', false)).status, 404);
    assert.equal((await t.setAccess(a.workspace.id, 'tenders', 'yes')).status, 400);

    await t.setAccess(a.workspace.id, 'tenders', false);
    const overview = await t.admin.request('GET', '/admin/workspace-modules');
    assert.equal(overview.status, 200);
    const row = overview.body.find(w => w.workspace_id === a.workspace.id);
    assert.equal(row.modules.find(m => m.module_id === 'tenders').workspace_enabled, false);
    assert.equal(overview.body.find(w => w.workspace_id === b.workspace.id).modules.find(m => m.module_id === 'tenders').enabled, true);
  } finally { await t.close(); }
});
