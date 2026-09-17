import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVacancySourceProviderRegistry, isSearchBreadth, SEARCH_BREADTH_LIMITS, DEFAULT_SEARCH_BREADTH } from '../dist/index.js';

function fakeProvider(id) {
  return { id, async findCandidates() { return { candidates: [], meta: [] }; } };
}

test('focused: only providers tagged for the focused tier are returned', () => {
  const registry = createVacancySourceProviderRegistry([
    { id: 'ts-jobspy', tiers: ['focused', 'standard', 'broad'], provider: fakeProvider('ts-jobspy') },
    { id: 'web-search', tiers: ['standard', 'broad'], provider: fakeProvider('web-search') },
  ]);
  const focused = registry.providersFor('focused');
  assert.deepEqual(focused.map(r => r.id), ['ts-jobspy']);
});

test('standard: job board and web search both participate', () => {
  const registry = createVacancySourceProviderRegistry([
    { id: 'ts-jobspy', tiers: ['focused', 'standard', 'broad'], provider: fakeProvider('ts-jobspy') },
    { id: 'web-search', tiers: ['standard', 'broad'], provider: fakeProvider('web-search') },
  ]);
  const standard = registry.providersFor('standard');
  assert.deepEqual(standard.map(r => r.id).sort(), ['ts-jobspy', 'web-search']);
});

test('broad: every registered provider participates', () => {
  const registry = createVacancySourceProviderRegistry([
    { id: 'ts-jobspy', tiers: ['focused', 'standard', 'broad'], provider: fakeProvider('ts-jobspy') },
    { id: 'web-search', tiers: ['standard', 'broad'], provider: fakeProvider('web-search') },
  ]);
  const broad = registry.providersFor('broad');
  assert.deepEqual(broad.map(r => r.id).sort(), ['ts-jobspy', 'web-search']);
});

test('a provider never registered for any tier is never returned', () => {
  const registry = createVacancySourceProviderRegistry([
    { id: 'experimental', tiers: [], provider: fakeProvider('experimental') },
  ]);
  assert.deepEqual(registry.providersFor('broad'), []);
});

test('each breadth tier defines hard, increasing server-side caps — never unlimited', () => {
  assert.ok(SEARCH_BREADTH_LIMITS.focused.maxTotalCandidates <= SEARCH_BREADTH_LIMITS.standard.maxTotalCandidates);
  assert.ok(SEARCH_BREADTH_LIMITS.standard.maxTotalCandidates <= SEARCH_BREADTH_LIMITS.broad.maxTotalCandidates);
  for (const tier of ['focused', 'standard', 'broad']) {
    const limits = SEARCH_BREADTH_LIMITS[tier];
    assert.ok(Number.isFinite(limits.maxCandidatesPerProvider) && limits.maxCandidatesPerProvider > 0);
    assert.ok(Number.isFinite(limits.maxTotalCandidates) && limits.maxTotalCandidates > 0);
    assert.ok(Number.isFinite(limits.maxEnrichments) && limits.maxEnrichments > 0);
    assert.ok(Number.isFinite(limits.providerTimeoutMs) && limits.providerTimeoutMs > 0);
  }
});

test('isSearchBreadth accepts only the three known tiers', () => {
  assert.equal(isSearchBreadth('focused'), true);
  assert.equal(isSearchBreadth('standard'), true);
  assert.equal(isSearchBreadth('broad'), true);
  assert.equal(isSearchBreadth('unlimited'), false);
  assert.equal(isSearchBreadth(undefined), false);
});

test('the default breadth is "standard" — today\'s original, unchanged behavior when a caller specifies nothing', () => {
  assert.equal(DEFAULT_SEARCH_BREADTH, 'standard');
});
