import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFromSource, SourceError } from '@discovery-platform/core';
import { createTedSource, parseTedFilters, buildTedQuery, TED_FIELDS, mapTedNotice } from '../dist/index.js';
import { fakeTed, fakeClock, notice } from './fake-ted.mjs';

const many = n => Array.from({ length: n }, (_, i) => notice({ 'publication-number': `${600001 + i}-2026` }));
const make = (notices, { fake, source } = {}) => {
  const f = fakeTed(notices, fake);
  const clock = fakeClock();
  return { source: createTedSource({ fetch: f.fetch, clock, minIntervalMs: 0, ...source }), fake: f, clock };
};
const FILTERS = { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' };

test('it is a domain-neutral DiscoverySource of kind "api": generic provenance plus the notice as raw', async () => {
  const { source } = make(many(2));
  assert.equal(source.id, 'ted');
  assert.equal(source.kind, 'api');
  const batch = await source.fetchBatch({ cursor: null, filters: FILTERS, limit: 10 });
  assert.deepEqual(Object.keys(batch.items[0]).sort(), ['externalId', 'fetchedAt', 'raw', 'sourceUrl']);
  assert.equal(batch.items[0].externalId, '600001-2026');
  assert.equal(batch.items[0].sourceUrl, 'https://ted.europa.eu/nl/notice/-/detail/600001-2026');
  assert.equal(batch.items[0].raw['procedure-identifier'].slice(0, 8), '11111111');
});

test('the official Search API is called with POST, an expert query, exactly the fields the mapping needs and PAGE_NUMBER paging', async () => {
  const { source, fake } = make(many(1));
  await source.fetchBatch({ cursor: null, filters: FILTERS, limit: 10 });
  const [call] = fake.calls;
  assert.equal(call.url, 'https://api.ted.europa.eu/v3/notices/search');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { query: 'buyer-country=NLD AND publication-date>=20260919 AND publication-date<=20260921', fields: [...TED_FIELDS], page: 1, limit: 10, paginationMode: 'PAGE_NUMBER' });
  assert.ok(TED_FIELDS.includes('procedure-identifier') && TED_FIELDS.includes('deadline-receipt-tender-date-lot') && TED_FIELDS.includes('estimated-value-proc'));
});

test('pagination and cursor: batches of 2 over 5 notices give 3 batches, then exhausted; nothing is lost or repeated', async () => {
  const { source, fake } = make(many(5));
  const first = await source.fetchBatch({ cursor: null, filters: FILTERS, limit: 2 });
  assert.deepEqual(first.items.map(i => i.externalId), ['600001-2026', '600002-2026']);
  assert.equal(first.nextCursor, '2:2');
  assert.equal(first.exhausted, false);
  const second = await source.fetchBatch({ cursor: first.nextCursor, filters: FILTERS, limit: 2 });
  assert.deepEqual(second.items.map(i => i.externalId), ['600003-2026', '600004-2026']);
  const third = await source.fetchBatch({ cursor: second.nextCursor, filters: FILTERS, limit: 2 });
  assert.deepEqual(third.items.map(i => i.externalId), ['600005-2026']);
  assert.deepEqual([third.exhausted, third.nextCursor], [true, null]);
  assert.deepEqual(fake.calls.map(c => c.body.page), [1, 2, 3]);
  const all = await collectFromSource(make(many(7)).source, { filters: FILTERS, batchSize: 3, maxItems: 100 });
  assert.equal(all.items.length, 7);
  assert.equal(all.batches, 3);
  const cut = await collectFromSource(make(many(7)).source, { filters: FILTERS, batchSize: 3, maxItems: 4 });
  assert.equal(cut.nextCursor, '2:3', 'resumes before the batch that was cut short');
});

test('an exact multiple of the page size ends with an empty last page, never an endless walk', async () => {
  const collected = await collectFromSource(make(many(4)).source, { filters: FILTERS, batchSize: 2, maxItems: 100 });
  assert.equal(collected.items.length, 4);
  assert.equal(collected.exhausted, true);
});

test('bad cursors are refused', async () => {
  const { source } = make(many(1));
  for (const cursor of ['abc', '0:5', '1:0', '1:251', '99999:5']) await assert.rejects(() => source.fetchBatch({ cursor, filters: FILTERS, limit: 250 }), error => error.code === 'invalid_filters', cursor);
  await assert.rejects(() => source.fetchBatch({ cursor: '1:100', filters: FILTERS, limit: 50 }), error => error.code === 'invalid_filters');
});

test('filters -> query: publication date, country (default NLD) and CPV / NUTS prefixes as wildcards', () => {
  const today = new Date('2026-09-21T12:00:00Z');
  assert.equal(buildTedQuery(parseTedFilters({}, today)), 'buyer-country=NLD AND publication-date>=20260920 AND publication-date<=20260921');
  assert.equal(buildTedQuery(parseTedFilters({ ...FILTERS, country: 'BEL' }, today)), 'buyer-country=BEL AND publication-date>=20260919 AND publication-date<=20260921');
  assert.equal(buildTedQuery(parseTedFilters({ ...FILTERS, cpvPrefixes: ['45'] }, today)), 'buyer-country=NLD AND publication-date>=20260919 AND publication-date<=20260921 AND classification-cpv=45*');
  assert.equal(buildTedQuery(parseTedFilters({ ...FILTERS, cpvPrefixes: ['45', '72000000'], nutsPrefixes: ['NL41'] }, today)),
    'buyer-country=NLD AND publication-date>=20260919 AND publication-date<=20260921 AND (classification-cpv=45* OR classification-cpv=72000000*) AND place-of-performance=NL41*');
});

test('filters are validated: a bad country, an over-long or inverted range, malformed prefixes are refused, not sent', () => {
  const today = new Date('2026-09-21T12:00:00Z');
  const refuse = filters => assert.throws(() => parseTedFilters(filters, today), error => error instanceof SourceError && error.code === 'invalid_filters', JSON.stringify(filters));
  for (const country of ['NL', 'nld', 'NLDX', 5, 'N1D']) refuse({ country });
  refuse({ publishedFrom: '2026-08-01', publishedTo: '2026-09-21' });
  refuse({ publishedFrom: '2026-09-21', publishedTo: '2026-09-20' });
  refuse({ publishedFrom: '21-09-2026' });
  refuse({ cpvPrefixes: ['45*'] });
  refuse({ cpvPrefixes: ['4'] });
  refuse({ nutsPrefixes: ['nl41'] });
  refuse({ nutsPrefixes: ['NL41 OR x'] });
  assert.equal(parseTedFilters({ country: '' }, today).country, 'NLD');
});

test('filters take effect: the date range, the country, CPV and NUTS prefixes select what the API returns', async () => {
  const notices = [
    notice({ 'publication-number': '600001-2026', 'publication-date': '2026-09-18+02:00' }),
    notice({ 'publication-number': '600002-2026', 'classification-cpv': ['45200000'], 'place-of-performance': ['NL33A', 'NLD'] }),
    notice({ 'publication-number': '600003-2026', 'classification-cpv': ['72000000'], 'place-of-performance': ['NL411', 'NLD'] }),
    notice({ 'publication-number': '600004-2026', 'buyer-country': 'BEL', 'classification-cpv': ['45200000'] }),
    notice({ 'publication-number': '600005-2026', 'publication-date': '2026-09-20+02:00', 'classification-cpv': ['45100000', '45210000'], 'place-of-performance': ['NL411', 'NLD'] }),
  ];
  const ids = async filters => (await collectFromSource(make(notices).source, { filters, batchSize: 10, maxItems: 100 })).items.map(i => i.externalId);
  assert.deepEqual(await ids(FILTERS), ['600002-2026', '600003-2026', '600005-2026'], 'date range and country NLD');
  assert.deepEqual(await ids({ publishedFrom: '2026-09-18', publishedTo: '2026-09-18' }), ['600001-2026']);
  assert.deepEqual(await ids({ ...FILTERS, country: 'BEL' }), ['600004-2026']);
  assert.deepEqual(await ids({ ...FILTERS, cpvPrefixes: ['45'] }), ['600002-2026', '600005-2026']);
  assert.deepEqual(await ids({ ...FILTERS, cpvPrefixes: ['72', '451'] }), ['600003-2026', '600005-2026']);
  assert.deepEqual(await ids({ ...FILTERS, nutsPrefixes: ['NL41'] }), ['600003-2026', '600005-2026']);
  assert.deepEqual(await ids({ ...FILTERS, cpvPrefixes: ['45'], nutsPrefixes: ['NL41'] }), ['600005-2026']);
});

test('a query that matches more than the pageable window is refused with advice, not silently truncated', async () => {
  const { source } = make(many(1), { fake: { totalOverride: 20_000 } });
  await assert.rejects(() => source.fetchBatch({ cursor: null, filters: FILTERS, limit: 250 }), error => error.code === 'invalid_filters' && /narrow/.test(error.message));
});

test('errors are explicit: timeout, timedOut flag, HTTP errors (retried only when transient), invalid JSON and shape', async () => {
  const run = (options, retries = 1) => make(many(1), { ...options, source: { maxRetries: retries } });
  const timeout = run({ fake: { failures: () => Object.assign(new Error('t'), { name: 'TimeoutError' }) } });
  await assert.rejects(() => timeout.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 }), error => error.code === 'timeout' && error.retryable);
  assert.equal(timeout.source.stats().requests, 2);
  const flagged = run({ fake: { failures: () => new Response(JSON.stringify({ notices: [], totalNoticeCount: 0, timedOut: true }), { status: 200 }) } });
  await assert.rejects(() => flagged.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 }), error => error.code === 'timeout');
  const badQuery = run({ fake: { failures: () => new Response(JSON.stringify({ message: 'Syntax error' }), { status: 400 }) } });
  await assert.rejects(() => badQuery.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 }), error => error.code === 'http' && error.status === 400 && !error.retryable);
  assert.equal(badQuery.source.stats().requests, 1, 'a 400 is not retried');
  const busy = run({ fake: { failures: n => (n === 1 ? new Response('busy', { status: 503 }) : undefined) } });
  assert.equal((await busy.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 })).items.length, 1);
  assert.equal(busy.source.stats().retries, 1);
  const notJson = run({ fake: { failures: () => new Response('<html>', { status: 200 }) } });
  await assert.rejects(() => notJson.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 }), error => error.code === 'invalid_response');
  const shape = run({ fake: { failures: () => new Response('{"items":[]}', { status: 200 }) } });
  await assert.rejects(() => shape.source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5 }), error => error.code === 'invalid_response');
});

test('notices without a usable publication number are skipped, and a foreign link is never used as the source URL', async () => {
  const fake = fakeTed([notice({ 'publication-number': '600001-2026', links: { html: { NLD: 'https://evil.example/x' } } })]);
  const original = fake.fetch;
  const patched = async (url, init) => { const r = await original(url, init); const b = await r.json(); b.notices.push({ 'publication-number': 'abc' }, { title: 'no number' }); return new Response(JSON.stringify(b), { status: 200 }); };
  const source = createTedSource({ fetch: patched, clock: fakeClock(), minIntervalMs: 0 });
  const batch = await source.fetchBatch({ cursor: null, filters: FILTERS, limit: 10 });
  assert.deepEqual(batch.items.map(i => i.externalId), ['600001-2026']);
  assert.equal(batch.items[0].sourceUrl, 'https://ted.europa.eu/en/notice/-/detail/600001-2026');
});

test('repeating the same fetch gives the same items and facts (idempotent), and a request that is aborted stops at once', async () => {
  const notices = [notice({ 'publication-number': '600001-2026' }), notice({ 'publication-number': '600002-2026', 'title-proc': { eng: 'Only English' } })];
  const facts = async () => (await collectFromSource(make(notices).source, { filters: FILTERS, batchSize: 1, maxItems: 10 })).items.map(mapTedNotice);
  assert.deepEqual(await facts(), await facts());
  const controller = new AbortController();
  controller.abort();
  const { source, fake } = make(many(1));
  await assert.rejects(() => source.fetchBatch({ cursor: null, filters: FILTERS, limit: 5, signal: controller.signal }), error => error.code === 'aborted');
  assert.equal(fake.calls.length, 0);
});
