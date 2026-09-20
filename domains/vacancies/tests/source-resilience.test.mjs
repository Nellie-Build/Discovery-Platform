import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTsJobSpySourceProvider, summarizeSources, sourceFailure } from '../dist/index.js';

test('source isolation: network retry is bounded, 429 is not retried and retains Retry-After', async () => {
  const calls = { indeed: 0, linkedin: 0 };
  const provider = createTsJobSpySourceProvider({ scrapeJobsImpl: async ({ sites }) => {
    const site = sites[0]; calls[site]++;
    if (site === 'linkedin') throw Object.assign(new Error('Secret must not leak'), { response: { status: 429, headers: { 'retry-after': '60' } } });
    if (calls[site] === 1) throw new Error('ECONNRESET token=secret');
    return { jobs: [], meta: { sites: [{ site, status: 'empty', jobs: 0, durationMs: 1 }] } };
  } });
  const result = await provider.findCandidates({ query: 'Security' });
  assert.deepEqual(calls, { indeed: 2, linkedin: 1 });
  assert.equal(result.meta[1].status, 'rate_limited');
  assert.equal(result.meta[1].retryAfterMs, 60000);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(summarizeSources(result.meta).status, 'partial');
  assert.equal(summarizeSources(result.meta).stopReason, 'source_rate_limited');
});

test('all failures, legitimate empty and unavailable sources produce distinct outcomes', () => {
  assert.equal(summarizeSources([{ status: 'error' }, { status: 'error' }]).stopReason, 'all_sources_failed');
  assert.equal(summarizeSources([{ status: 'not_configured' }]).stopReason, 'source_unavailable');
  assert.equal(summarizeSources([{ status: 'empty' }, { status: 'not_configured' }]).status, 'succeeded');
  assert.equal(sourceFailure(new Error('Timeout: Authorization secret')).errorType, 'timeout');
});
