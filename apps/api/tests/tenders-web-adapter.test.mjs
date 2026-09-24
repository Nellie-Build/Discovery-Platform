import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createTenderNedSource, createTedSource } from '@discovery-platform/domain-tenders';
import { createTendersAdapter } from '../dist/domains/tenders-adapter.js';
import { startTestApp } from './helpers/test-app.mjs';
import { SITE, page, webTransport, fakeSearchProvider } from '../../../domains/tenders/tests/fake-web.mjs';

/**
 * Tenders beyond the APIs: an organisation's website, a web search by branch/keywords/region and the `auto` source that combines
 * TenderNed, TED and the search. Real adapter, real crawl engine and real API sources over in-memory sites and fake API
 * responses. No network. The module is enabled per test app, exactly as an admin would.
 */
const HOST = 'gemeente-voorbeeld.example';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const clock = () => { let now = Date.parse('2026-09-21T12:00:00Z'); return { now: () => now, sleep: async ms => { now += ms; } }; };
const runConfig = (over = {}) => ({ targetRecords: 50, searchBreadth: 'standard', budgetSource: 'adaptive', maxPages: 20, maxCandidates: 100, maxDurationMs: 60_000, maxEnrichments: 5, onlyNewRecords: true, ...over });

// Fake TenderNed and TED: two publications each, one matching the keywords "onderhoud scholen" and one not.
function tenderNedFetch({ fail = false } = {}) {
  const publications = [
    { id: '1', kenmerk: '900', name: 'Onderhoud schoolgebouwen 2027', authority: 'Gemeente Voorbeeld' },
    { id: '2', kenmerk: '901', name: 'Levering kantoormeubilair', authority: 'Gemeente Voorbeeld' },
  ];
  return async input => {
    if (fail) return new Response('down', { status: 500 });
    const url = new URL(String(input));
    const detail = /\/publicaties\/(\d+)$/.exec(url.pathname);
    if (detail) return json({ publicatieId: Number(detail[1]), kenmerk: publications.find(p => p.id === detail[1]).kenmerk, cpvCodes: [{ isHoofdOpdracht: true, code: '45000000-7' }], nutsCodes: [{ code: 'NL33', omschrijving: 'Zuid-Holland' }] });
    const content = publications.map(p => ({ publicatieId: p.id, publicatieDatum: '2026-09-21', typePublicatie: { code: 'AAO', omschrijving: 'Aankondiging opdracht' }, aanbestedingNaam: p.name, opdrachtgeverNaam: p.authority, sluitingsDatum: '2026-11-02T08:00:00', kenmerk: p.kenmerk }));
    return json({ content: Number(url.searchParams.get('page')) === 0 ? content : [], last: true, totalPages: 1, number: 0, size: 100 });
  };
}
const tedNotice = (number, title) => ({
  'publication-number': number, 'notice-identifier': `nid-${number}`, 'procedure-identifier': `proc-${number.split('-')[0]}`, 'notice-type': 'cn-standard', 'publication-date': '2026-09-21+02:00',
  'title-proc': { nld: title }, 'buyer-name': { nld: ['Gemeente Voorbeeld'] }, 'buyer-country': 'NLD', 'procedure-type': 'open', 'contract-nature': ['services'],
  'classification-cpv': ['45000000'], 'place-of-performance': ['NL33', 'NLD'], links: { html: { NLD: `https://ted.europa.eu/nl/notice/-/detail/${number}` } },
});
const tedFetch = notices => async (_url, init) => {
  const body = JSON.parse(init.body);
  return json({ notices: notices.slice((body.page - 1) * body.limit, body.page * body.limit).map(n => Object.fromEntries(Object.entries(n).filter(([key]) => body.fields.includes(key)))), totalNoticeCount: notices.length, iterationNextToken: null, timedOut: false });
};

async function app({ sites = { [HOST]: SITE }, provider, apis = {} } = {}) {
  const { transport, calls } = webTransport(sites);
  const adapter = createTendersAdapter({
    web: { crawler: createDiscoveryCrawler('legacy'), transport, clock: clock(), searchProvider: provider },
    sources: {
      tenderned: () => createTenderNedSource({ fetch: tenderNedFetch(apis), clock: clock(), minIntervalMs: 0, maxRetries: 0 }),
      ted: () => createTedSource({ fetch: tedFetch([tedNotice('700001-2026', 'Onderhoud scholen regio'), tedNotice('700002-2026', 'Schoonmaak kantoren')]), clock: clock(), minIntervalMs: 0, maxRetries: 0 }),
    },
  });
  const t = await startTestApp({ apiKey: 'test-key', domainRegistry: { tenders: adapter } });
  await t.db.query("UPDATE modules SET enabled = true, status = 'active' WHERE id = 'tenders'");
  const workspace = (await t.request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await t.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Tenders', domain: 'tenders' } })).body;
  const start = async body => (await t.request('POST', `/projects/${project.id}/runs`, { body })).body;
  return {
    ...t, calls, project, start,
    records: async () => (await t.request('GET', `/projects/${project.id}/records`)).body,
    snapshot: async () => JSON.stringify([(await t.db.query('SELECT * FROM discovery_records ORDER BY id')).rows, (await t.db.query('SELECT * FROM record_sources ORDER BY id')).rows]),
  };
}

const searchProvider = () => fakeSearchProvider([
  ['aanbesteding', [[`https://${HOST}/aanbestedingen`, 'Aanbestedingen - Gemeente Voorbeeld', 'Lopende aanbestedingen']]],
  ['tender', [[`https://${HOST}/aanbestedingen/security-services`, 'Request for Proposal: security services']]],
]);

test('a website run (a URL) creates tender records from the concrete tender pages only, with per-record provenance', async () => {
  const t = await app();
  try {
    const run = await t.start({ sourceUrl: `https://${HOST}/`, runConfig: { targetRecords: 20 } });
    assert.equal(run.status, 'succeeded');
    assert.equal(run.recordsCreated, 4);
    assert.equal(run.stats.searchMode, 'website');
    assert.equal(run.stats.sourceId, 'website');
    assert.equal(run.stats.concreteTenders, 4);
    assert.ok(run.stats.overviewPages >= 1 && run.stats.generalInformationPages >= 1, 'overview and general pages are counted, not recorded');
    const records = await t.records();
    assert.equal(records.length, 4);
    assert.ok(records.every(r => r.domain_data.sourceSystem === 'website' && r.domain_data.discovery.via === 'website_crawl'));
    assert.ok(!records.some(r => /leveranciers|inkoopbeleid|workshop|nieuws/.test(r.domain_data.sourceUrl)), 'no supplier-information, event or news page became a tender');
    const rfp = records.find(r => r.domain_data.sourceUrl.endsWith('/security-services'));
    assert.equal(rfp.domain_data.referenceNumber, 'RFP-2026-07');
    assert.equal(rfp.domain_data.submissionDeadline, '2026-11-03T14:00:00');
    assert.equal(rfp.domain_data.discovery.host, HOST);
    const { rows } = await t.db.query('SELECT source_type, source_label, source_url FROM record_sources WHERE source_url LIKE $1', ['%/security-services']);
    assert.deepEqual(rows.map(r => [r.source_type, r.source_label, r.source_url]), [['website', 'website', `https://${HOST}/aanbestedingen/security-services`]]);
  } finally { await t.close(); }
});

test('a repeated website run changes nothing; a changed deadline on a page updates that record only', async () => {
  const sites = { [HOST]: structuredClone(SITE) };
  const t = await app({ sites });
  try {
    await t.start({ sourceUrl: `https://${HOST}/` });
    const after = await t.snapshot();
    const again = await t.start({ sourceUrl: `https://${HOST}/` });
    assert.equal(again.recordsCreated, 0);
    assert.equal(again.recordsUpdated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 4);
    assert.equal(await t.snapshot(), after, 'the record tables are identical after the second run');
    sites[HOST]['/aanbestedingen/schilderwerk-sporthal'].body = sites[HOST]['/aanbestedingen/schilderwerk-sporthal'].body.replace('20-11-2026', '27-11-2026');
    const changed = await t.start({ sourceUrl: `https://${HOST}/` });
    assert.equal(changed.recordsCreated, 0);
    assert.equal(changed.recordsUpdated, 1);
    assert.equal((await t.records()).find(r => r.domain_data.sourceUrl.endsWith('/schilderwerk-sporthal')).domain_data.submissionDeadline, '2026-11-27T10:00:00');
  } finally { await t.close(); }
});

test('a branch run (branch + keywords + region + country) searches with tender intents and records what it found with search provenance', async () => {
  const provider = searchProvider();
  const t = await app({ provider });
  try {
    const run = await t.start({ branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'Nederland', filters: { maxQueries: 2 } });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.stats.searchMode, 'branch');
    assert.equal(run.stats.sourceId, 'search');
    assert.deepEqual(provider.queries.map(q => q.query), ['aanbesteding Bouw renovatie schoolgebouwen Zuid-Holland', 'tender Bouw renovatie schoolgebouwen Zuid-Holland']);
    assert.equal(run.recordsCreated, 4);
    assert.equal(run.stats.overviewCrawls, 1, 'the overview found by search led to one crawl of that site');
    const records = await t.records();
    assert.ok(records.every(r => r.domain_data.discovery.via === 'web_search'));
    const found = records.find(r => r.domain_data.sourceUrl.endsWith('/renovatie-basisschool-de-ster'));
    assert.match(found.domain_data.discovery.query, /Bouw renovatie schoolgebouwen Zuid-Holland$/);
    const { rows } = await t.db.query("SELECT DISTINCT source_label, source_type FROM record_sources");
    assert.deepEqual(rows.map(r => [r.source_label, r.source_type]), [['search', 'website']]);
    // Idempotent: the same search again creates nothing.
    const again = await t.start({ branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'Nederland', filters: { maxQueries: 2 } });
    assert.equal(again.recordsCreated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 4);
  } finally { await t.close(); }
});

test('a search run without a configured search provider fails plainly instead of returning nothing', async () => {
  const t = await app();
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const run = await t.start({ branch: 'Bouw' });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /zoekprovider/);
    const bad = await t.start({ sourceId: 'search', filters: {} });
    assert.match(bad.error, /branche of zoektermen/);
  } finally { if (previous !== undefined) process.env.BRAVE_SEARCH_API_KEY = previous; await t.close(); }
});

test('auto: TenderNed, TED and the web search each contribute; keywords narrow the API results; records of different sources are never merged', async () => {
  const t = await app({ provider: searchProvider() });
  try {
    const run = await t.start({ sourceId: 'auto', filters: { branch: 'Bouw', keywords: 'onderhoud scholen', country: 'NL', publishedFrom: '2026-09-21', publishedTo: '2026-09-21', maxQueries: 2 } });
    assert.equal(run.status, 'succeeded', run.error);
    assert.deepEqual(run.stats.sources.map(s => [s.sourceId, s.status]), [['tenderned', 'ok'], ['ted', 'ok'], ['search', 'ok']]);
    assert.equal(run.stats.filteredByKeywords, 2, 'the office furniture and cleaning tenders do not match "onderhoud scholen"');
    const records = await t.records();
    const bySystem = {};
    for (const r of records) (bySystem[r.domain_data.sourceSystem] ??= []).push(r.domain_data.title);
    assert.deepEqual(bySystem.tenderned, ['Onderhoud schoolgebouwen 2027']);
    assert.deepEqual(bySystem.ted, ['Onderhoud scholen regio']);
    assert.equal(bySystem.website.length, 4);
    assert.equal(run.recordsCreated, 6);
    assert.deepEqual(run.stats.recordsBySource, { tenderned: 1, ted: 1, website: 4 });
    // Nothing merged: the two "onderhoud scholen" tenders are separate records with their own source.
    const { rows } = await t.db.query('SELECT DISTINCT source_label FROM record_sources ORDER BY source_label');
    assert.deepEqual(rows.map(r => r.source_label), ['search', 'ted', 'tenderned']);
    const again = await t.start({ sourceId: 'auto', filters: { branch: 'Bouw', keywords: 'onderhoud scholen', country: 'NL', publishedFrom: '2026-09-21', publishedTo: '2026-09-21', maxQueries: 2 } });
    assert.equal(again.recordsCreated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 6);
  } finally { await t.close(); }
});

test('auto shares the wanted number between sources instead of letting one source fill it', async () => {
  const t = await app({ provider: searchProvider() });
  try {
    const run = await t.start({ sourceId: 'auto', filters: { keywords: 'onderhoud scholen', branch: 'Bouw', publishedFrom: '2026-09-21', publishedTo: '2026-09-21', maxQueries: 2 }, runConfig: { targetRecords: 3 } });
    assert.equal(run.recordsCreated, 3);
    assert.deepEqual(Object.keys(run.stats.recordsBySource).sort(), ['ted', 'tenderned', 'website']);
    assert.equal(run.stats.stopReason, 'target_reached');
  } finally { await t.close(); }
});

test('auto without a search provider skips the search and says so; a failing source makes the run partial, not failed', async () => {
  const noSearch = await app();
  try {
    const run = await noSearch.start({ sourceId: 'auto', filters: { keywords: 'onderhoud scholen', publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } });
    assert.equal(run.status, 'succeeded');
    const search = run.stats.sources.find(s => s.sourceId === 'search');
    assert.equal(search.status, 'skipped');
    assert.match(search.reason, /zoekprovider/);
  } finally { await noSearch.close(); }
  const partial = await app({ apis: { fail: true } });
  try {
    const run = await partial.start({ sourceId: 'auto', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } });
    assert.equal(run.status, 'partial');
    assert.equal(run.stats.sources.find(s => s.sourceId === 'tenderned').status, 'failed');
    assert.ok(run.recordsCreated > 0, 'TED still delivered');
  } finally { await partial.close(); }
});

test('auto rejects an unknown source name and a request no source fits', async () => {
  const t = await app();
  try {
    assert.match((await t.start({ sourceId: 'auto', filters: { sources: ['bing'] } })).error, /Onbekende bron/);
    assert.match((await t.start({ sourceId: 'auto', filters: { sources: ['search'] } })).error, /Geen enkele bron past/);
  } finally { await t.close(); }
});

test('TenderNed and TED still work exactly as before as direct sources (source runs, no web involved)', async () => {
  const t = await app();
  try {
    const nl = await t.start({ sourceId: 'tenderned', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } });
    assert.equal(nl.status, 'succeeded');
    assert.equal(nl.recordsCreated, 2);
    assert.equal(nl.stats.searchMode, 'source');
    const ted = await t.start({ sourceId: 'ted', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } });
    assert.equal(ted.recordsCreated, 2);
    assert.equal(t.calls.length, 0, 'no website was requested');
    assert.equal((await t.start({ sourceId: 'nope', filters: {} })).error, 'Onbekende bron "nope".');
  } finally { await t.close(); }
});

test('the same tender text on a website and in TenderNed stays two records (no automatic cross-source merge)', async () => {
  const sites = { [HOST]: { '/robots.txt': SITE['/robots.txt'], '/': { body: page('Home', '<a href="/aanbestedingen/x">x</a>') }, '/aanbestedingen/x': { body: page('Aanbesteding Onderhoud schoolgebouwen 2027', '<h1>Aanbesteding Onderhoud schoolgebouwen 2027</h1><dl><dt>Kenmerk</dt><dd>900</dd><dt>Sluitingsdatum</dt><dd>2 november 2026 om 08:00 uur</dd></dl>') } } };
  const t = await app({ sites });
  try {
    await t.start({ sourceUrl: `https://${HOST}/` });
    await t.start({ sourceId: 'tenderned', filters: { publishedFrom: '2026-09-21', publishedTo: '2026-09-21' } });
    const records = await t.records();
    const same = records.filter(r => r.domain_data.title === 'Onderhoud schoolgebouwen 2027' || r.domain_data.title === 'Aanbesteding Onderhoud schoolgebouwen 2027');
    assert.equal(same.length, 2);
    assert.deepEqual(same.map(r => r.domain_data.sourceSystem).sort(), ['tenderned', 'website']);
    assert.ok(same.every(r => r.domain_data.referenceNumber === '900' || r.domain_data.tenderIdentity === '900'), 'even an equal reference number does not merge them');
  } finally { await t.close(); }
});

test('provenance of page tenders: the run mode (website / search / auto), the host role, the publisher and how the authority was found are stored; API tenders keep theirs', async () => {
  const t = await app({ provider: searchProvider() });
  try {
    await t.start({ sourceUrl: `https://${HOST}/` });
    const website = (await t.records()).filter(r => r.domain_data.sourceSystem === 'website');
    assert.ok(website.length > 0);
    for (const r of website) {
      const d = r.domain_data.discovery;
      assert.deepEqual([d.mode, d.via, d.sourceRole, d.publisher, d.host], ['website', 'website_crawl', 'official_organization_site', 'Gemeente Voorbeeld', HOST]);
      assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0);
    }
    const bouw = website.find(r => r.domain_data.sourceUrl.endsWith('/renovatie-basisschool-de-ster'));
    assert.equal(bouw.domain_data.contractingAuthority, 'Gemeente Voorbeeld');
    assert.equal(bouw.domain_data.discovery.authoritySource, 'label');
    assert.equal(website.find(r => r.domain_data.sourceUrl.endsWith('/schilderwerk-sporthal')).domain_data.contractingAuthority, null, 'no label, no authority: the publisher is not used');

    const auto = await t.start({ sourceId: 'auto', filters: { branch: 'Bouw', keywords: 'onderhoud scholen', publishedFrom: '2026-09-21', publishedTo: '2026-09-21', maxQueries: 2 } });
    assert.equal(auto.status, 'succeeded', auto.error);
    const all = await t.records();
    const ned = all.find(r => r.domain_data.sourceSystem === 'tenderned');
    assert.equal(ned.domain_data.discovery, undefined, 'TenderNed keeps its own provenance, no web discovery block');
    assert.equal(all.filter(r => r.domain_data.sourceSystem === 'website' && r.domain_data.discovery.mode === 'auto').length, 0, 'pages already stored by the website run are unchanged, not re-labelled');
    assert.ok(auto.stats.source_search.sourceRoles.official_organization_site >= 1);
  } finally { await t.close(); }
  const fresh = await app({ provider: searchProvider() });
  try {
    await fresh.start({ sourceId: 'auto', filters: { branch: 'Bouw', keywords: 'onderhoud scholen', publishedFrom: '2026-09-21', publishedTo: '2026-09-21', maxQueries: 2 } });
    const viaAuto = (await fresh.records()).filter(r => r.domain_data.sourceSystem === 'website');
    assert.ok(viaAuto.length > 0 && viaAuto.every(r => r.domain_data.discovery.mode === 'auto' && r.domain_data.discovery.via === 'web_search'));
    const search = await fresh.start({ branch: 'Bouw', keywords: 'renovatie', filters: { maxQueries: 1 } });
    assert.equal(search.stats.searchMode, 'branch');
  } finally { await fresh.close(); }
});
