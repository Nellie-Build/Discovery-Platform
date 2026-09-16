import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient } from '../dist/client.js';
import { ApiError } from '../dist/types.js';

/** Replaces global.fetch for one test, recording every call and returning a canned response. */
function fakeFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('every request includes credentials: "include" — the session cookie, never a token', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(200, { status: 'ok' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    await client.auth.me();
    assert.equal(calls[0].init.credentials, 'include');
  } finally { restore(); }
});

test('auth.login posts to /auth/login with the exact email/password body', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(200, { id: 'u1', email: 'a@example.com' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    const user = await client.auth.login('a@example.com', 'secret');
    assert.equal(calls[0].url, 'http://api.test/api/v1/auth/login');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'a@example.com', password: 'secret' });
    assert.equal(user.email, 'a@example.com');
  } finally { restore(); }
});

test('a non-2xx response throws ApiError with the server\'s own error code and message, never a raw Response', async () => {
  const { restore } = fakeFetch(() => jsonResponse(404, { error: 'not_found', message: 'Project not found.' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    await assert.rejects(client.projects.get('missing-id'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'not_found');
      assert.equal(error.message, 'Project not found.');
      return true;
    });
  } finally { restore(); }
});

test('projects.listByWorkspace URL-encodes the workspaceId query parameter', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(200, []));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    await client.projects.listByWorkspace('a b/c');
    assert.equal(calls[0].url, 'http://api.test/api/v1/projects?workspaceId=a%20b%2Fc');
  } finally { restore(); }
});

test('runs.start posts the sourceUrl to /projects/:id/runs', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(201, { id: 'run1', status: 'succeeded' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    const run = await client.runs.start('project1', 'https://example.com');
    assert.equal(calls[0].url, 'http://api.test/api/v1/projects/project1/runs');
    assert.deepEqual(JSON.parse(calls[0].init.body), { sourceUrl: 'https://example.com' });
    assert.equal(run.status, 'succeeded');
  } finally { restore(); }
});

test('runs.startBranchSearch posts branch/region/keywords to /projects/:id/runs, leaving runs.start\'s own sourceUrl request shape untouched', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(201, { id: 'run2', status: 'succeeded' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    const run = await client.runs.startBranchSearch('project1', { branch: 'Security', region: 'Nederland' });
    assert.equal(calls[0].url, 'http://api.test/api/v1/projects/project1/runs');
    assert.deepEqual(JSON.parse(calls[0].init.body), { branch: 'Security', region: 'Nederland' });
    assert.equal(run.status, 'succeeded');
  } finally { restore(); }
});

test('runs.startBranchSearch works with region/keywords both omitted — only branch is required', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(201, { id: 'run3', status: 'succeeded' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    await client.runs.startBranchSearch('project1', { branch: 'Security' });
    assert.deepEqual(JSON.parse(calls[0].init.body), { branch: 'Security' });
  } finally { restore(); }
});

test('auth.logout returns void for a 204 response without trying to parse a body', async () => {
  const { restore } = fakeFetch(() => ({ ok: true, status: 204, text: async () => '' }));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    const result = await client.auth.logout();
    assert.equal(result, undefined);
  } finally { restore(); }
});

test('records.listByProject omits the domain query parameter when none is given', async () => {
  const { calls, restore } = fakeFetch(() => jsonResponse(200, []));
  try {
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1' });
    await client.records.listByProject('project1');
    assert.equal(calls[0].url, 'http://api.test/api/v1/projects/project1/records');
  } finally { restore(); }
});
