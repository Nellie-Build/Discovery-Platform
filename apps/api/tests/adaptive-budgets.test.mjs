import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDiscoveryRunConfig, ABSOLUTE_MAX_PAGES, ABSOLUTE_MAX_CANDIDATES, ABSOLUTE_MAX_DURATION_MS } from '../dist/discovery-run-config.js';

test('adaptive budgets scale by target, breadth and module, within safety caps', () => {
  const small = resolveDiscoveryRunConfig({ targetRecords: 10 });
  const large = resolveDiscoveryRunConfig({ targetRecords: 100 });
  for (const key of ['maxPages', 'maxCandidates', 'maxDurationMs']) assert.ok(small[key] < large[key]);
  assert.equal(small.budgetSource, 'adaptive');
  assert.equal(resolveDiscoveryRunConfig().maxPages, 130);
  assert.ok(resolveDiscoveryRunConfig({ targetRecords: 10, searchBreadth: 'focused' }).maxPages < small.maxPages);
  assert.ok(resolveDiscoveryRunConfig({ targetRecords: 10, searchBreadth: 'broad' }).maxPages > small.maxPages);
  assert.ok(resolveDiscoveryRunConfig({ targetRecords: 10 }, 'other').maxPages < small.maxPages);
});

test('partial Advanced override preserves adaptive defaults; invalid values cannot bypass caps', () => {
  const config = resolveDiscoveryRunConfig({ targetRecords: 10, maxPages: 7 });
  assert.equal(config.budgetSource, 'advanced');
  assert.equal(config.maxPages, 7);
  assert.equal(config.maxCandidates, resolveDiscoveryRunConfig({ targetRecords: 10 }).maxCandidates);
  const capped = resolveDiscoveryRunConfig({ maxPages: 1e9, maxCandidates: 1e9, maxDurationMs: 1e9 });
  assert.equal(capped.maxPages, ABSOLUTE_MAX_PAGES);
  assert.equal(capped.maxCandidates, ABSOLUTE_MAX_CANDIDATES);
  assert.equal(capped.maxDurationMs, ABSOLUTE_MAX_DURATION_MS);
  assert.equal(resolveDiscoveryRunConfig({ maxPages: NaN, maxDurationMs: Infinity }).budgetSource, 'adaptive');
  assert.equal(resolveDiscoveryRunConfig({ searchBreadth: 'advanced' }).budgetSource, 'adaptive');
});
