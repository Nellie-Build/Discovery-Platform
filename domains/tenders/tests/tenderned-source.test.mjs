import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFromSource, SourceError } from '@discovery-platform/core';
import { createTenderNedSource, parseTenderNedFilters, MAX_RANGE_DAYS } from '../dist/index.js';
import { fakeTenderNed, fakeClock, publication } from './fake-tenderned.mjs';

const many = n => Array.from({ length: n }, (_, i) => publication({ id: 440000 + i }));
const source = (publications, options = {}, fake = fakeTenderNed(publications, options.fake)) => {
  const clock = options.clock ?? fakeClock();
  return { source: createTenderNedSource({ fetch: fake.fetch, clock, minIntervalMs: 300, ...options.source }), fake, clock };
};

test('it is a domain-neutral DiscoverySource: id, kind "api", items with only generic provenance plus raw', async () => {
  const { source: s } = source(many(2));
  assert.equal(s.id, 'tenderned');
  assert.equal(s.kind, 'api');
  const batch = await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.equal(batch.items.length, 2);
  assert.deepEqual(Object.keys(batch.items[0]).sort(), ['externalId', 'fetchedAt', 'raw', 'sourceUrl']);
  assert.equal(batch.items[0].externalId, '440000');
  assert.equal(batch.items[0].sourceUrl, 'https://www.tenderned.nl/aankondigingen/overzicht/440000');
  assert.ok(batch.items[0].fetchedAt.startsWith('2026-09-21T12:00:0') && batch.items[0].fetchedAt.endsWith('Z'), batch.items[0].fetchedAt);
  assert.ok(batch.items[0].raw.detail, 'the detail document is fetched too');
});

test('pagination and cursor: batches of 2 over 5 publications give 3 batches, then exhausted; nothing is lost or repeated', async () => {
  const { source: s, fake } = source(many(5));
  const first = await s.fetchBatch({ cursor: null, filters: {}, limit: 2 });
  assert.deepEqual(first.items.map(i => i.externalId), ['440000', '440001']);
  assert.equal(first.exhausted, false);
  assert.equal(first.nextCursor, '1:2');
  const second = await s.fetchBatch({ cursor: first.nextCursor, filters: {}, limit: 2 });
  assert.deepEqual(second.items.map(i => i.externalId), ['440002', '440003']);
  const third = await s.fetchBatch({ cursor: second.nextCursor, filters: {}, limit: 2 });
  assert.deepEqual(third.items.map(i => i.externalId), ['440004']);
  assert.equal(third.exhausted, true);
  assert.equal(third.nextCursor, null);
  assert.ok(fake.calls.some(call => call.includes('page=2&size=2')));
});

test('collectFromSource walks the whole range within limits, and stops on the item limit without losing the resume point', async () => {
  const all = await collectFromSource(source(many(7)).source, { batchSize: 3, maxItems: 100 });
  assert.deepEqual(all.items.map(i => i.externalId), many(7).map(p => p.id));
  assert.equal(all.exhausted, true);
  assert.equal(all.batches, 3);
  const limited = await collectFromSource(source(many(7)).source, { batchSize: 3, maxItems: 4 });
  assert.equal(limited.items.length, 4);
  assert.equal(limited.stopReason, 'item_limit');
  assert.equal(limited.nextCursor, '1:3', 'resumes before the batch that was cut short');
});

test('an unknown or oversized cursor is refused', async () => {
  const { source: s } = source(many(1));
  for (const cursor of ['abc', '1', '1:0', '1:101', '99999999:2']) {
    await assert.rejects(() => s.fetchBatch({ cursor, filters: {}, limit: 10 }), error => error instanceof SourceError && error.code === 'invalid_filters', cursor);
  }
  await assert.rejects(() => s.fetchBatch({ cursor: '0:50', filters: {}, limit: 10 }), error => error.code === 'invalid_filters', 'a cursor page size larger than the limit');
});

test('date filter: the publication date range is sent to TenderNed and only that range comes back', async () => {
  const publications = [publication({ id: 1, date: '2026-09-18' }), publication({ id: 2, date: '2026-09-19' }), publication({ id: 3, date: '2026-09-20' }), publication({ id: 4, date: '2026-09-21' })];
  const { source: s, fake } = source(publications);
  const batch = await s.fetchBatch({ cursor: null, filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-20' }, limit: 50 });
  assert.deepEqual(batch.items.map(i => i.externalId), ['2', '3']);
  assert.ok(fake.calls[0].includes('publicatieDatumVanaf=2026-09-19') && fake.calls[0].includes('publicatieDatumTot=2026-09-20'));
});

test('date filter: without dates it is the last two days (never everything); a lone start date is bounded too', () => {
  const today = new Date('2026-09-21T15:30:00Z');
  assert.deepEqual(parseTenderNedFilters({}, today), { publishedFrom: '2026-09-20', publishedTo: '2026-09-21', cpvPrefixes: [], nutsPrefixes: [] });
  assert.deepEqual(parseTenderNedFilters({ publishedFrom: '2026-09-10' }, today), { publishedFrom: '2026-09-10', publishedTo: '2026-09-11', cpvPrefixes: [], nutsPrefixes: [] });
  assert.equal(parseTenderNedFilters({ publishedTo: '2026-09-15' }, today).publishedFrom, '2026-09-14');
  assert.equal(parseTenderNedFilters({ publishedFrom: '2026-09-21' }, today).publishedTo, '2026-09-21');
});

test('date filter: a range longer than the maximum, an inverted range and malformed dates are refused, not shortened', () => {
  const today = new Date('2026-09-21T00:00:00Z');
  const refuse = filters => assert.throws(() => parseTenderNedFilters(filters, today), error => error instanceof SourceError && error.code === 'invalid_filters', JSON.stringify(filters));
  refuse({ publishedFrom: '2026-01-01', publishedTo: '2026-09-21' });
  refuse({ publishedFrom: '2026-06-01', publishedTo: '2026-09-21' });
  refuse({ publishedFrom: '2026-09-21', publishedTo: '2026-09-20' });
  refuse({ publishedFrom: '21-09-2026' });
  refuse({ publishedFrom: '2026-02-30' });
  refuse({ publishedFrom: 20260921 });
  refuse({ cpvPrefixes: ['abc'] });
  refuse({ nutsPrefixes: ['n l'] });
  assert.doesNotThrow(() => parseTenderNedFilters({ publishedFrom: '2026-09-08', publishedTo: '2026-09-21' }, today), 'exactly 14 days is allowed');
  assert.equal(MAX_RANGE_DAYS, 90);
});

test('client-side CPV and NUTS filters: only matching publications are returned, and the dropped ones are counted', async () => {
  const publications = [
    publication({ id: 1, cpv: [{ isHoofdOpdracht: true, code: '45200000-9', omschrijving: 'Bouw' }], nuts: [{ code: 'NL33', omschrijving: 'Zuid-Holland' }] }),
    publication({ id: 2, cpv: [{ isHoofdOpdracht: true, code: '77000000-0', omschrijving: 'Tuinbouw' }], nuts: [{ code: 'NL22', omschrijving: 'Gelderland' }] }),
    publication({ id: 3, cpv: [{ isHoofdOpdracht: true, code: '45100000-8', omschrijving: 'Bouwplaats' }, { isHoofdOpdracht: false, code: '77000000-0', omschrijving: 'x' }], nuts: [{ code: 'NL33', omschrijving: 'Zuid-Holland' }] }),
  ];
  const cpv = source(publications);
  const byCpv = await cpv.source.fetchBatch({ cursor: null, filters: { cpvPrefixes: ['45'] }, limit: 10 });
  assert.deepEqual(byCpv.items.map(i => i.externalId), ['1', '3']);
  assert.equal(cpv.source.stats().filteredOut, 1);
  const both = source(publications);
  const bothBatch = await both.source.fetchBatch({ cursor: null, filters: { cpvPrefixes: ['77'], nutsPrefixes: ['NL33'] }, limit: 10 });
  assert.deepEqual(bothBatch.items.map(i => i.externalId), ['3']);
  assert.equal(both.source.stats().filteredOut, 2);
  const none = await source(publications).source.fetchBatch({ cursor: null, filters: { nutsPrefixes: ['NL9'] }, limit: 10 });
  assert.deepEqual(none.items, []);
  assert.equal(none.exhausted, true);
});

test('a filtered batch that keeps nothing is still not the end: the cursor moves on', async () => {
  const publications = many(4).map(p => ({ ...p, nuts: [{ code: 'NL22', omschrijving: 'Gelderland' }] }));
  const { source: s } = source(publications);
  const batch = await s.fetchBatch({ cursor: null, filters: { nutsPrefixes: ['NL33'] }, limit: 2 });
  assert.deepEqual(batch.items, []);
  assert.equal(batch.exhausted, false);
  assert.equal(batch.nextCursor, '1:2');
  const collected = await collectFromSource(source(publications).source, { filters: { nutsPrefixes: ['NL33'] }, batchSize: 2, maxItems: 10 });
  assert.equal(collected.exhausted, true);
});

test('a missing detail is tolerated (the item keeps its list data), and a CPV filter cannot vouch for it', async () => {
  const failing = { fake: { failures: url => (/\/publicaties\/440001$/.test(url.pathname) ? new Response('boom', { status: 500 }) : undefined) } };
  const { source: s } = source(many(3), { ...failing, source: { maxRetries: 0 } });
  const batch = await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.equal(batch.items.length, 3);
  const broken = batch.items.find(i => i.externalId === '440001');
  assert.equal(broken.raw.detail, null);
  assert.match(broken.raw.detailError, /^http: /);
  assert.ok(broken.raw.list.aanbestedingNaam);
  assert.equal(s.stats().detailFailures, 1);
  const filtered = source(many(3), { ...failing, source: { maxRetries: 0 } });
  const kept = await filtered.source.fetchBatch({ cursor: null, filters: { cpvPrefixes: ['77'] }, limit: 10 });
  assert.deepEqual(kept.items.map(i => i.externalId), ['440000', '440002']);
});

test('the detail fetch can be switched off (list data only)', async () => {
  const { source: s, fake } = source(many(2), { source: { fetchDetails: false } });
  const batch = await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.equal(batch.items[0].raw.detail, null);
  assert.equal(batch.items[0].raw.detailError, null);
  assert.equal(fake.calls.length, 1);
});

test('moderate request pace: a pause of at least minIntervalMs between every two requests', async () => {
  const clock = fakeClock();
  const times = [];
  const inner = fakeTenderNed(many(3)).fetch;
  const paced = createTenderNedSource({ fetch: async input => { times.push(clock.now()); return inner(input); }, clock, minIntervalMs: 300 });
  await paced.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 300, `gap ${times[i] - times[i - 1]}`);
  assert.equal(paced.stats().requests, 4);
});

test('transient failures are retried with a pause, then succeed; the retries are counted', async () => {
  const clock = fakeClock();
  const { source: s } = source(many(1), { clock, fake: { failures: (url, n) => (n <= 2 && url.pathname.endsWith('/publicaties') ? new Response('busy', { status: 503 }) : undefined) } });
  const batch = await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.equal(batch.items.length, 1);
  assert.equal(s.stats().retries, 2);
  assert.ok(clock.sleeps.some(ms => ms >= 1000), 'backs off before retrying');
});

test('Retry-After is honoured (capped), 429 is retried', async () => {
  const clock = fakeClock();
  const { source: s } = source(many(1), { clock, source: { fetchDetails: false }, fake: { failures: (url, n) => (n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : undefined) } });
  await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.ok(clock.sleeps.includes(7000));
});

test('errors are explicit: a timeout, an HTTP error, invalid JSON and an unexpected shape each have their own code', async () => {
  const timeout = source(many(1), { source: { maxRetries: 1 }, fake: { failures: () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }) } });
  await assert.rejects(() => timeout.source.fetchBatch({ cursor: null, filters: {}, limit: 5 }), error => error.code === 'timeout' && error.retryable === true);
  assert.equal(timeout.source.stats().requests, 2, 'one retry, then it gives up');
  const notFound = source(many(1), { fake: { failures: () => new Response('nope', { status: 404 }) } });
  await assert.rejects(() => notFound.source.fetchBatch({ cursor: null, filters: {}, limit: 5 }), error => error.code === 'http' && error.status === 404 && error.retryable === false);
  assert.equal(notFound.source.stats().requests, 1, 'a 404 is not retried');
  const serverDown = source(many(1), { source: { maxRetries: 1 }, fake: { failures: () => new Response('x', { status: 502 }) } });
  await assert.rejects(() => serverDown.source.fetchBatch({ cursor: null, filters: {}, limit: 5 }), error => error.code === 'http' && error.status === 502);
  const notJson = source(many(1), { fake: { failures: () => new Response('<html>', { status: 200 }) } });
  await assert.rejects(() => notJson.source.fetchBatch({ cursor: null, filters: {}, limit: 5 }), error => error.code === 'invalid_response');
  const wrongShape = source(many(1), { fake: { failures: () => new Response('{"items":[]}', { status: 200 }) } });
  await assert.rejects(() => wrongShape.source.fetchBatch({ cursor: null, filters: {}, limit: 5 }), error => error.code === 'invalid_response');
});

test('an abort signal stops the source immediately', async () => {
  const { source: s, fake } = source(many(1));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => s.fetchBatch({ cursor: null, filters: {}, limit: 5, signal: controller.signal }), error => error.code === 'aborted');
  assert.equal(fake.calls.length, 0);
});

test('entries without a usable publication id are skipped, and only TenderNed links are kept as the source URL', async () => {
  const fake = fakeTenderNed(many(1));
  const inner = fake.fetch;
  const patched = async input => {
    const response = await inner(input);
    if (!String(input).includes('/publicaties?')) return response;
    const body = await response.json();
    body.content.push({ aanbestedingNaam: 'no id' }, { publicatieId: 'abc' }, { ...body.content[0], publicatieId: 440777, link: { href: 'https://evil.example/x' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const s = createTenderNedSource({ fetch: patched, clock: fakeClock(), minIntervalMs: 0, fetchDetails: false });
  const batch = await s.fetchBatch({ cursor: null, filters: {}, limit: 10 });
  assert.deepEqual(batch.items.map(i => i.externalId), ['440000', '440777']);
  assert.equal(batch.items[1].sourceUrl, 'https://www.tenderned.nl/aankondigingen/overzicht/440777');
});
