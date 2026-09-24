import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTenderNedFilters, planTenderSearch, suggestCpv, tenderOpportunityStatus, createTenderNedSource, parseTedFilters, buildTedQuery } from '../dist/index.js';

test('official video disambiguation offers production and equipment as separate choices', () => {
  assert.deepEqual(suggestCpv('video').slice(0, 2).map(v => v.code), ['92111000', '32321200']);
  assert.match(suggestCpv('32321200')[0].label, /Audiovisuele/);
  assert.deepEqual(suggestCpv('xyznonexistent'), []);
  for (const code of ['92111000', '32321200']) {
    const plan = planTenderSearch({ cpvPrefixes: [code], country: 'NL' }, true);
    assert.deepEqual(plan.steps.map(s => s.sourceId), ['ted', 'tenderned', 'search']);
    assert.deepEqual(plan.steps[0].filters.cpvPrefixes, [code.replace(/0+$/, '')]);
    assert.equal(plan.steps[0].filters.keywords, '');
    assert.ok(plan.steps[2].filters.keywords);
  }
});

test('TED sends full-text, CPV and buyer-country together; expert-query injection stays literal', () => {
  const query = buildTedQuery(parseTedFilters({ keywords: 'video" OR buyer-country=USA', cpvPrefixes: ['92111000'], country: 'NLD' }));
  assert.match(query, /^buyer-country=NLD/);
  assert.match(query, /classification-cpv=92111\*/);
  assert.match(query, /FT~"video"/);
  assert.ok(!query.includes('buyer-country=USA'));
});

test('TenderNed covers a longer interval in disjoint seven-day blocks including empty blocks', async () => {
  const urls = [];
  const source = createTenderNedSource({ minIntervalMs: 0, fetch: async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ content: [], last: true }));
  } });
  let cursor = null;
  let exhausted = false;
  do {
    const batch = await source.fetchBatch({ filters: { publishedFrom: '2026-09-01', publishedTo: '2026-09-16' }, cursor, limit: 25 });
    cursor = batch.nextCursor; exhausted = batch.exhausted;
  } while (!exhausted && urls.length < 10);
  assert.deepEqual(urls.map(u => [u.searchParams.get('publicatieDatumVanaf'), u.searchParams.get('publicatieDatumTot')]), [
    ['2026-09-10', '2026-09-16'], ['2026-09-03', '2026-09-09'], ['2026-09-01', '2026-09-02'],
  ]);
  assert.equal(exhausted, true);
});

test('opportunity status distinguishes open, expired, missing deadline and awards with inherited deadlines', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  assert.equal(tenderOpportunityStatus({ submissionDeadline: '2026-09-24T13:00:00' }, now), 'open');
  assert.equal(tenderOpportunityStatus({ submissionDeadline: '2026-09-24T11:00:00' }, now), 'expired');
  assert.equal(tenderOpportunityStatus({ submissionDeadline: '2026-09-24' }, now), 'unknown');
  assert.equal(tenderOpportunityStatus({ submissionDeadline: null }, now), 'unknown');
  assert.equal(tenderOpportunityStatus({ submissionDeadline: '2027-01-01', noticeType: 'can-standard' }, now), 'expired');
});

test('TenderNed receives CPV prefixes server-side (hierarchical code, repeated parameter) instead of scanning every publication', async () => {
  const urls = [];
  const source = createTenderNedSource({ minIntervalMs: 0, fetch: async url => { urls.push(new URL(url)); return new Response(JSON.stringify({ content: [], last: true })); } });
  await source.fetchBatch({ filters: { publishedFrom: '2026-09-20', publishedTo: '2026-09-21', cpvPrefixes: ['92111000', '3232'] }, cursor: null, limit: 25 });
  assert.deepEqual(urls[0].searchParams.getAll('cpvCodes'), ['92111000-0', '32320000-0']);
});

test('a full CPV code is a category: 92111000 also covers its subcategory 92111200, never the whole division', () => {
  const { cpvPrefixes } = parseTenderNedFilters({ cpvPrefixes: ['92111000', '45000000', '3232'] });
  assert.deepEqual(cpvPrefixes, ['92111', '45', '3232']);
  assert.ok('92111200'.startsWith(cpvPrefixes[0]) && !'92110000'.startsWith(cpvPrefixes[0]));
});
