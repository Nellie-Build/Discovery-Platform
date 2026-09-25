import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

async function registerNewUser(client) {
  const email = uniqueEmail();
  const res = await client.request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });
  return { email, user: res.body.user, workspace: res.body.workspace };
}

async function makeAdmin(db, userId) {
  await db.query('UPDATE users SET is_admin = true WHERE id = $1', [userId]);
}

test('a non-admin logged-in user gets 403 on every /admin route', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const client = createClient();
    await registerNewUser(client);
    assert.equal((await client.request('GET', '/admin/modules')).status, 403);
    assert.equal((await client.request('PATCH', '/admin/modules/vacancies', { body: { enabled: false } })).status, 403);
    assert.equal((await client.request('GET', '/admin/projects')).status, 403);
  } finally { await close(); }
});

test('an unauthenticated caller gets 401, not 403, on an admin route', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('GET', '/admin/modules');
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('an admin sees the seeded Module Registry: vacancies active/enabled, the other modules coming_soon/disabled', async () => {
  const { createClient, close, db } = await startTestApp();
  try {
    const client = createClient();
    const { user } = await registerNewUser(client);
    await makeAdmin(db, user.id);

    const res = await client.request('GET', '/admin/modules');
    assert.equal(res.status, 200);
    const vacancies = res.body.find(m => m.id === 'vacancies');
    const companies = res.body.find(m => m.id === 'housing');
    assert.equal(vacancies.enabled, true);
    assert.equal(vacancies.status, 'active');
    assert.equal(companies.enabled, false);
    assert.equal(companies.status, 'coming_soon');
  } finally { await close(); }
});

test('an admin can disable the vacancies module — after that, no new vacancies project can be created and no new run can be started, but existing data stays reachable', async () => {
  const { createClient, close, db } = await startTestApp();
  try {
    const admin = createClient();
    const { user: adminUser } = await registerNewUser(admin);
    await makeAdmin(db, adminUser.id);

    const owner = createClient();
    const { workspace } = await registerNewUser(owner);
    const project = (await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'P', domain: 'vacancies' } })).body;

    const toggle = await admin.request('PATCH', '/admin/modules/vacancies', { body: { enabled: false } });
    assert.equal(toggle.status, 200);
    assert.equal(toggle.body.enabled, false);

    const newProject = await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Blocked', domain: 'vacancies' } });
    assert.equal(newProject.status, 403);
    assert.equal(newProject.body.error, 'module_disabled');

    const newRun = await owner.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(newRun.status, 403);
    assert.equal(newRun.body.error, 'module_disabled');

    // Existing project/data are untouched — still fully readable.
    const stillReadable = await owner.request('GET', `/projects/${project.id}`);
    assert.equal(stillReadable.status, 200);
  } finally { await close(); }
});

test('re-enabling a module restores project creation and run starting', async () => {
  const { createClient, close, db } = await startTestApp();
  try {
    const admin = createClient();
    const { user: adminUser } = await registerNewUser(admin);
    await makeAdmin(db, adminUser.id);
    await admin.request('PATCH', '/admin/modules/vacancies', { body: { enabled: false } });
    await admin.request('PATCH', '/admin/modules/vacancies', { body: { enabled: true } });

    const owner = createClient();
    const { workspace } = await registerNewUser(owner);
    const project = await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'P', domain: 'vacancies' } });
    assert.equal(project.status, 201);
  } finally { await close(); }
});

test('the admin project list includes both active and soft-deleted projects, across workspaces, with the workspace name attached', async () => {
  const { createClient, close, db } = await startTestApp();
  try {
    const admin = createClient();
    const { user: adminUser } = await registerNewUser(admin);
    await makeAdmin(db, adminUser.id);

    const owner = createClient();
    const { workspace } = await registerNewUser(owner);
    const active = (await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Active one', domain: 'vacancies' } })).body;
    const toDelete = (await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Deleted one', domain: 'vacancies' } })).body;
    await owner.request('DELETE', `/projects/${toDelete.id}`);

    const list = await admin.request('GET', '/admin/projects');
    assert.equal(list.status, 200);
    const activeRow = list.body.find(p => p.id === active.id);
    const deletedRow = list.body.find(p => p.id === toDelete.id);
    assert.ok(activeRow);
    assert.equal(activeRow.deleted_at, null);
    assert.equal(activeRow.workspace_name, workspace.name);
    assert.ok(deletedRow);
    assert.ok(deletedRow.deleted_at, 'the soft-deleted project must still show up for admin, with deleted_at set');
  } finally { await close(); }
});

test('an admin can restore a soft-deleted project — it reappears in the normal project list', async () => {
  const { createClient, close, db } = await startTestApp();
  try {
    const admin = createClient();
    const { user: adminUser } = await registerNewUser(admin);
    await makeAdmin(db, adminUser.id);

    const owner = createClient();
    const { workspace } = await registerNewUser(owner);
    const project = (await owner.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'P', domain: 'vacancies' } })).body;
    await owner.request('DELETE', `/projects/${project.id}`);
    assert.equal((await owner.request('GET', `/projects/${project.id}`)).status, 404);

    const restore = await admin.request('POST', `/admin/projects/${project.id}/restore`);
    assert.equal(restore.status, 200);
    assert.equal(restore.body.deleted_at, null);

    const backInList = await owner.request('GET', `/projects?workspaceId=${workspace.id}`);
    assert.ok(backInList.body.some(p => p.id === project.id));
  } finally { await close(); }
});
