import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, uniqueEmail } from './helpers/test-app.mjs';

test('register creates a user, a workspace, and logs them in — a session cookie is set', async () => {
  const { request, close } = await startTestApp();
  try {
    const email = uniqueEmail();
    const res = await request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, email);
    assert.ok(res.body.user.id);
    assert.ok(!('password_hash' in res.body.user), 'the password hash must never be sent to the client');
    assert.equal(res.body.workspace.name, 'My workspace');

    // The session cookie set during register keeps the caller logged in.
    const me = await request('GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, email);
  } finally { await close(); }
});

test('register rejects a duplicate email, an invalid email, and a too-short password', async () => {
  const { request, close } = await startTestApp();
  try {
    const email = uniqueEmail();
    await request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });

    const duplicate = await request('POST', '/auth/register', { body: { email, password: 'another-password-456' } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'email_taken');

    const badEmail = await request('POST', '/auth/register', { body: { email: 'not-an-email', password: 'a-secure-password-123' } });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error, 'invalid_email');

    const shortPassword = await request('POST', '/auth/register', { body: { email: uniqueEmail(), password: 'short' } });
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.body.error, 'invalid_password');
  } finally { await close(); }
});

test('login succeeds with the right password and rejects the wrong one, without revealing which field was wrong', async () => {
  const { createClient, close } = await startTestApp();
  try {
    const email = uniqueEmail();
    const registerClient = createClient();
    await registerClient.request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });

    const loginClient = createClient();
    const wrongPassword = await loginClient.request('POST', '/auth/login', { body: { email, password: 'wrong-password' } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error, 'invalid_credentials');

    const unknownEmail = await loginClient.request('POST', '/auth/login', { body: { email: uniqueEmail(), password: 'whatever-123' } });
    assert.equal(unknownEmail.status, 401);
    assert.equal(unknownEmail.body.error, 'invalid_credentials');
    assert.equal(unknownEmail.body.message, wrongPassword.body.message, 'the same generic message either way — never confirm which email exists');

    const rightPassword = await loginClient.request('POST', '/auth/login', { body: { email, password: 'a-secure-password-123' } });
    assert.equal(rightPassword.status, 200);
    assert.equal(rightPassword.body.email, email);

    const me = await loginClient.request('GET', '/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, email);
  } finally { await close(); }
});

test('logout ends the session — /auth/me is unauthorized afterward', async () => {
  const { request, close } = await startTestApp();
  try {
    const email = uniqueEmail();
    await request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });
    assert.equal((await request('GET', '/auth/me')).status, 200);

    const logout = await request('POST', '/auth/logout');
    assert.equal(logout.status, 204);

    const me = await request('GET', '/auth/me');
    assert.equal(me.status, 401);
  } finally { await close(); }
});

test('/auth/me is unauthorized for a caller who never logged in', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('GET', '/auth/me');
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('GET /workspaces (mine) lists exactly the workspace a freshly registered user was given', async () => {
  const { request, close } = await startTestApp();
  try {
    const email = uniqueEmail();
    const registered = await request('POST', '/auth/register', { body: { email, password: 'a-secure-password-123' } });

    const mine = await request('GET', '/workspaces');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.length, 1);
    assert.equal(mine.body[0].id, registered.body.workspace.id);
    assert.equal(mine.body[0].role, 'owner');
  } finally { await close(); }
});

test('a project created without ever logging in is rejected — a session or dev API key is required', async () => {
  const { request, close } = await startTestApp();
  try {
    const res = await request('POST', '/projects', { body: { workspaceId: '00000000-0000-4000-8000-000000000000', name: 'X', domain: 'vacancies' } });
    assert.equal(res.status, 401);
  } finally { await close(); }
});
