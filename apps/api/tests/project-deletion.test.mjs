import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

async function registerNewUser(client) {
  const email = uniqueEmail();
  const res = await client.request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });
  return { email, user: res.body.user, workspace: res.body.workspace };
}

test('a user can soft-delete their own project — it disappears from the normal project list, but the API confirms with 204', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const client = createClient();
    const { workspace } = await registerNewUser(client);
    const project = (await client.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'To delete', domain: 'vacancies' } })).body;

    const del = await client.request('DELETE', `/projects/${project.id}`);
    assert.equal(del.status, 204);

    const list = await client.request('GET', `/projects?workspaceId=${workspace.id}`);
    assert.deepEqual(list.body.map(p => p.id), []);

    const get = await client.request('GET', `/projects/${project.id}`);
    assert.equal(get.status, 404, 'a soft-deleted project reads the same as not-found through the normal GET');
  } finally { await close(); }
});

test('records and runs are not physically deleted — they still exist internally after a soft delete (visible via the admin project list, see admin.test.mjs)', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: '<html><body><a href="/vacatures/role">role</a></body></html>' },
    '/vacatures/role': { body: `<html><head><title>Role</title><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Support Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    })}</script></head><body></body></html>` },
  };
  const { createClient, close, db } = await startTestApp({ pages });
  try {
    const client = createClient();
    const { workspace } = await registerNewUser(client);
    const project = (await client.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'To delete', domain: 'vacancies' } })).body;
    const run = await client.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.body.recordsCreated, 1);

    await client.request('DELETE', `/projects/${project.id}`);

    const { rows: recordRows } = await db.query('SELECT * FROM discovery_records WHERE project_id = $1', [project.id]);
    const { rows: runRows } = await db.query('SELECT * FROM discovery_runs WHERE project_id = $1', [project.id]);
    assert.equal(recordRows.length, 1, 'the record must still exist in the database after a soft delete');
    assert.equal(runRows.length, 1, 'the run must still exist in the database after a soft delete');
  } finally { await close(); }
});

test('a deleted project can never start a new Discovery Run', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const client = createClient();
    const { workspace } = await registerNewUser(client);
    const project = (await client.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'To delete', domain: 'vacancies' } })).body;
    await client.request('DELETE', `/projects/${project.id}`);

    const run = await client.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.status, 404);
  } finally { await close(); }
});

test('a user from another workspace cannot delete someone else\'s project', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const clientA = createClient();
    const { workspace: workspaceA } = await registerNewUser(clientA);
    const projectA = (await clientA.request('POST', '/projects', { body: { workspaceId: workspaceA.id, name: 'A project', domain: 'vacancies' } })).body;

    const clientB = createClient();
    await registerNewUser(clientB);

    const del = await clientB.request('DELETE', `/projects/${projectA.id}`);
    assert.equal(del.status, 404, 'a non-member gets 404, never a 403 that would confirm the project exists');

    const stillThere = await clientA.request('GET', `/projects/${projectA.id}`);
    assert.equal(stillThere.status, 200, 'the legitimate owner\'s project must be untouched');
  } finally { await close(); }
});

test('deleting an already-deleted project gives a clean 404, not a crash or a silent no-op', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const client = createClient();
    const { workspace } = await registerNewUser(client);
    const project = (await client.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'To delete', domain: 'vacancies' } })).body;

    const first = await client.request('DELETE', `/projects/${project.id}`);
    assert.equal(first.status, 204);

    const second = await client.request('DELETE', `/projects/${project.id}`);
    assert.equal(second.status, 404);
    assert.equal(second.body.error, 'not_found');
  } finally { await close(); }
});

test('deleting an unknown project id gives the same clean 404', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const client = createClient();
    await registerNewUser(client);
    const res = await client.request('DELETE', '/projects/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  } finally { await close(); }
});
