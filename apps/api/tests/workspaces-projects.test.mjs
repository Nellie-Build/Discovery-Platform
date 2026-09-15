import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './helpers/test-app.mjs';

test('POST /workspaces creates a workspace, GET /workspaces/:id reads it back', async () => {
  const { request, close } = await startTestApp();
  try {
    const create = await request('POST', '/workspaces', { body: { name: 'Acme Recruiting' } });
    assert.equal(create.status, 201);
    assert.equal(create.body.name, 'Acme Recruiting');
    assert.ok(create.body.id);

    const read = await request('GET', `/workspaces/${create.body.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, create.body);
  } finally { await close(); }
});

test('POST /workspaces rejects a missing name', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('POST', '/workspaces', { body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_name');
  } finally { await close(); }
});

test('GET /workspaces/:id returns 404 for an unknown (but well-formed) id', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('GET', '/workspaces/00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 404);
  } finally { await close(); }
});

test('GET /workspaces/:id returns 400 for a malformed id, never a raw database error', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('GET', '/workspaces/not-a-uuid');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_id');
  } finally { await close(); }
});

test('POST /projects creates a project scoped to its workspace, with a validated domain', async () => {
  const { request, close } = await startTestApp();
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    const create = await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Vacancy scan', domain: 'vacancies' } });
    assert.equal(create.status, 201);
    assert.equal(create.body.workspace_id, workspace.id);
    assert.equal(create.body.domain, 'vacancies');
    assert.equal(create.body.status, 'active');

    const read = await request('GET', `/projects/${create.body.id}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, create.body);
  } finally { await close(); }
});

test('POST /projects rejects an unknown domain, an unknown workspace, and a missing name', async () => {
  const { request, close } = await startTestApp();
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;

    const badDomain = await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'X', domain: 'companies' } });
    assert.equal(badDomain.status, 400);
    assert.equal(badDomain.body.error, 'unknown_domain');

    const badWorkspace = await request('POST', '/projects', { body: { workspaceId: '00000000-0000-4000-8000-000000000000', name: 'X', domain: 'vacancies' } });
    assert.equal(badWorkspace.status, 404);

    const badName = await request('POST', '/projects', { body: { workspaceId: workspace.id, domain: 'vacancies' } });
    assert.equal(badName.status, 400);
  } finally { await close(); }
});

test('project isolation: GET /projects?workspaceId=... never returns another workspace\'s projects', async () => {
  const { request, close } = await startTestApp();
  try {
    const workspaceA = (await request('POST', '/workspaces', { body: { name: 'Workspace A' } })).body;
    const workspaceB = (await request('POST', '/workspaces', { body: { name: 'Workspace B' } })).body;
    const projectA = (await request('POST', '/projects', { body: { workspaceId: workspaceA.id, name: 'A project', domain: 'vacancies' } })).body;
    const projectB = (await request('POST', '/projects', { body: { workspaceId: workspaceB.id, name: 'B project', domain: 'vacancies' } })).body;

    const listA = await request('GET', `/projects?workspaceId=${workspaceA.id}`);
    const listB = await request('GET', `/projects?workspaceId=${workspaceB.id}`);
    assert.deepEqual(listA.body.map(p => p.id), [projectA.id]);
    assert.deepEqual(listB.body.map(p => p.id), [projectB.id]);
  } finally { await close(); }
});

test('GET /projects requires a workspaceId query parameter — there is no "list every project" endpoint', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('GET', '/projects');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_workspace_id');
  } finally { await close(); }
});

test('the dev API key protects every route except /health when configured', async () => {
  const { request, close } = await startTestApp({ apiKey: 'secret-dev-key' });
  try {
    const noKey = await request('POST', '/workspaces', { body: { name: 'W' } });
    assert.equal(noKey.status, 401);

    const wrongKey = await request('POST', '/workspaces', { body: { name: 'W' }, headers: { 'x-api-key': 'wrong' } });
    assert.equal(wrongKey.status, 401);

    const rightKey = await request('POST', '/workspaces', { body: { name: 'W' }, headers: { 'x-api-key': 'secret-dev-key' } });
    assert.equal(rightKey.status, 201);

    const health = await request('GET', '/health');
    assert.equal(health.status, 200);
  } finally { await close(); }
});
