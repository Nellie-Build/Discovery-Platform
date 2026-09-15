import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './helpers/test-app.mjs';

test('GET /api/v1/health responds ok without touching the database or requiring auth', async () => {
  const { request, close } = await startTestApp({ apiKey: 'secret-dev-key' });
  try {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  } finally { await close(); }
});
