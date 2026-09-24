import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsersRepository, WorkspacesRepository, WorkspaceMembersRepository } from '@discovery-platform/db';
import { devAuthBypassEnabled, createDevAuthBypass } from '../dist/auth/dev-bypass.js';
import { startTestApp } from './helpers/test-app.mjs';

test('bypass requires explicit development and never activates in production or Cloud Run', () => {
  for (const NODE_ENV of ['production', 'test', undefined]) {
    assert.equal(devAuthBypassEnabled({ NODE_ENV, DEV_AUTH_BYPASS: 'true' }), false);
  }
  assert.equal(devAuthBypassEnabled({ NODE_ENV: 'development', DEV_AUTH_BYPASS: 'false' }), false);
  assert.equal(devAuthBypassEnabled({ NODE_ENV: 'development', DEV_AUTH_BYPASS: 'true', K_SERVICE: 'api' }), false);
  assert.equal(devAuthBypassEnabled({ NODE_ENV: 'development', DEV_AUTH_BYPASS: 'true' }), true);
});

test('local identity preserves workspace isolation, normal login, and disappears when disabled', async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS, K_SERVICE: process.env.K_SERVICE };
  process.env.NODE_ENV = 'development';
  process.env.DEV_AUTH_BYPASS = 'true';
  delete process.env.K_SERVICE;
  const app = await startTestApp({ devAuthEmail: 'existing@example.com' });
  try {
    assert.equal((await app.request('GET', '/auth/me')).status, 401, 'missing account is not created');
    const user = await new UsersRepository(app.db).createUser('existing@example.com', 'unused');
    const spaces = new WorkspacesRepository(app.db);
    const own = await spaces.createWorkspace('Existing workspace');
    const other = await spaces.createWorkspace('Another workspace');
    await new WorkspaceMembersRepository(app.db).addMember(own.id, user.id, 'owner');
    const me = await app.request('GET', '/auth/me', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(me.status, 200);
    assert.equal(me.body.id, user.id);
    assert.equal('password_hash' in me.body, false);
    assert.deepEqual((await app.request('GET', '/workspaces')).body.map(w => w.id), [own.id]);
    assert.equal((await app.request('GET', `/projects?workspaceId=${own.id}`)).status, 200);
    assert.equal((await app.request('GET', `/projects?workspaceId=${other.id}`)).status, 404);
    for (const headers of [{ origin: 'https://evil.example' }, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }]) {
      assert.equal((await app.request('GET', '/auth/me', { headers })).status, 401);
    }
    for (const [remoteAddress, hostname] of [['192.168.1.2', 'localhost'], ['127.0.0.1', 'evil.example']]) {
      const req = { isAuthenticated: () => false, socket: { remoteAddress }, hostname };
      await new Promise((resolve, reject) => createDevAuthBypass(app.db, user.email)(req, {}, error => error ? reject(error) : resolve()));
      assert.equal(req.user, undefined);
    }
    const normal = app.createClient();
    const registered = await normal.registerAndLogin('normal@example.com');
    assert.equal((await normal.request('GET', '/auth/me')).body.id, registered.user.id, 'normal sessions win');
    assert.equal((await normal.request('POST', '/auth/logout')).status, 204);
    process.env.NODE_ENV = 'production';
    assert.equal((await app.request('GET', '/auth/me')).status, 401, 'true flag cannot bypass production');
    assert.equal((await app.request('GET', '/workspaces')).status, 401);
    process.env.NODE_ENV = 'development';
    process.env.K_SERVICE = 'cloud-api';
    assert.equal((await app.request('GET', '/auth/me')).status, 401);
    delete process.env.K_SERVICE;
    process.env.DEV_AUTH_BYPASS = 'false';
    assert.equal((await app.request('GET', '/auth/me')).status, 401, 'no bypass session persisted');
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
