import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

/**
 * The core security property this phase adds: a logged-in user may only ever see the
 * workspaces/projects/runs/records they are a member of — checked server-side (see
 * apps/api/src/workspace-access.ts), never trusting an id from the client alone.
 */
async function registerNewUser(client) {
  const email = uniqueEmail();
  const res = await client.request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });
  return { email, user: res.body.user, workspace: res.body.workspace };
}

test('workspace isolation: user B cannot read user A\'s workspace by id', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const clientA = createClient();
    const { workspace: workspaceA } = await registerNewUser(clientA);
    const clientB = createClient();
    await registerNewUser(clientB);

    const asOwner = await clientA.request('GET', `/workspaces/${workspaceA.id}`);
    assert.equal(asOwner.status, 200);

    const asOutsider = await clientB.request('GET', `/workspaces/${workspaceA.id}`);
    assert.equal(asOutsider.status, 404, 'a non-member gets 404, never a 403 that would confirm the workspace exists');
  } finally { await close(); }
});

test('unauthorized project access: user B cannot read, list, or create records in user A\'s project', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const clientA = createClient();
    const { workspace: workspaceA } = await registerNewUser(clientA);
    const projectA = (await clientA.request('POST', '/projects', { body: { workspaceId: workspaceA.id, name: 'A project', domain: 'vacancies' } })).body;

    const clientB = createClient();
    await registerNewUser(clientB);

    const readProject = await clientB.request('GET', `/projects/${projectA.id}`);
    assert.equal(readProject.status, 404);

    const listRecords = await clientB.request('GET', `/projects/${projectA.id}/records`);
    assert.equal(listRecords.status, 404);

    const startRun = await clientB.request('POST', `/projects/${projectA.id}/runs`, { body: { sourceUrl: 'https://example.com' } });
    assert.equal(startRun.status, 404);

    const listRuns = await clientB.request('GET', `/projects/${projectA.id}/runs`);
    assert.equal(listRuns.status, 404);

    // User B also cannot create a project inside workspace A directly.
    const createInWorkspaceA = await clientB.request('POST', '/projects', { body: { workspaceId: workspaceA.id, name: 'Intruder project', domain: 'vacancies' } });
    assert.equal(createInWorkspaceA.status, 404);
  } finally { await close(); }
});

test('a record id from another workspace cannot be used to read that workspace\'s data', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: '<html><body><a href="/vacatures/role">role</a></body></html>' },
    '/vacatures/role': { body: `<html><head><title>Role</title><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Support Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    })}</script></head><body></body></html>` },
  };
  const { createClient, close } = await startTestApp({ pages });
  try {
    const clientA = createClient();
    const { workspace: workspaceA } = await registerNewUser(clientA);
    const projectA = (await clientA.request('POST', '/projects', { body: { workspaceId: workspaceA.id, name: 'A project', domain: 'vacancies' } })).body;
    const run = await clientA.request('POST', `/projects/${projectA.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.body.recordsCreated, 1);
    const records = await clientA.request('GET', `/projects/${projectA.id}/records`);
    const recordId = records.body[0].id;
    const runId = run.body.id;

    const clientB = createClient();
    await registerNewUser(clientB);

    const recordAsB = await clientB.request('GET', `/records/${recordId}`);
    assert.equal(recordAsB.status, 404);

    const runAsB = await clientB.request('GET', `/runs/${runId}`);
    assert.equal(runAsB.status, 404);

    // The legitimate owner can still read both.
    assert.equal((await clientA.request('GET', `/records/${recordId}`)).status, 200);
    assert.equal((await clientA.request('GET', `/runs/${runId}`)).status, 200);
  } finally { await close(); }
});

test('two independent users each get their own workspace and never see each other\'s in GET /workspaces', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const clientA = createClient();
    const { workspace: workspaceA } = await registerNewUser(clientA);
    const clientB = createClient();
    const { workspace: workspaceB } = await registerNewUser(clientB);

    const minesA = await clientA.request('GET', '/workspaces');
    const minesB = await clientB.request('GET', '/workspaces');
    assert.deepEqual(minesA.body.map(w => w.id), [workspaceA.id]);
    assert.deepEqual(minesB.body.map(w => w.id), [workspaceB.id]);
  } finally { await close(); }
});
