import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createTenderNedSource, createTedSource } from '@discovery-platform/domain-tenders';
import { createTendersAdapter } from '../dist/domains/tenders-adapter.js';
import { startTestApp } from './helpers/test-app.mjs';
import { SITE, page, webTransport, fakeSearchProvider, MULTI_TENDER_CARDS } from '../../../domains/tenders/tests/fake-web.mjs';

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

test('the server-configuration search provider (no test override) resolves Tavily or Brave from SEARCH_PROVIDER/TAVILY_API_KEY/BRAVE_SEARCH_API_KEY exactly as documented, and an explicit choice without its key still fails plainly rather than silently falling back', async () => {
  const savedFetch = globalThis.fetch;
  const savedEnv = { SEARCH_PROVIDER: process.env.SEARCH_PROVIDER, TAVILY_API_KEY: process.env.TAVILY_API_KEY, BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY };
  const tavilyResult = url => json({ results: [{ url, title: 'Aanbestedingen - Gemeente Voorbeeld', content: 'Lopende aanbestedingen' }] });
  const braveResult = url => json({ web: { results: [{ url, title: 'Aanbestedingen - Gemeente Voorbeeld', description: 'Lopende aanbestedingen' }] } });
  // Only the two providers' own external endpoints are faked; everything else (notably the test harness's own HTTP
  // client below, `t.request`, which itself calls the real global fetch against the local test server) passes through
  // untouched — replacing global fetch outright would silently hijack those calls too.
  let respondWith = null;
  const calls = [];
  globalThis.fetch = (url, init) => {
    const href = String(url);
    if (respondWith && (href.startsWith('https://api.tavily.com/') || href.startsWith('https://api.search.brave.com/'))) {
      calls.push({ url: href, init });
      return respondWith(href);
    }
    return savedFetch(url, init);
  };
  const t = await app(); // no `provider` override: createTendersAdapter falls back to reading process.env itself.
  try {
    // 1. Neither SEARCH_PROVIDER nor an explicit choice: whichever key is set wins, Tavily first (its free plan is
    //    meant for exactly this kind of local run).
    delete process.env.SEARCH_PROVIDER;
    process.env.TAVILY_API_KEY = 'test-tavily-key';
    delete process.env.BRAVE_SEARCH_API_KEY;
    respondWith = () => tavilyResult(`https://${HOST}/aanbestedingen`);
    let run = await t.start({ branch: 'Bouw', keywords: 'x', filters: { maxQueries: 1 } });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.tavily.com/search');
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-tavily-key');

    // 2. Both keys set, but SEARCH_PROVIDER explicitly says brave: the explicit choice wins over the automatic precedence.
    process.env.SEARCH_PROVIDER = 'brave';
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
    calls.length = 0;
    respondWith = () => braveResult(`https://${HOST}/aanbestedingen`);
    run = await t.start({ branch: 'ICT', keywords: 'y', filters: { maxQueries: 1 } });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(calls.length, 1);
    const braveUrl = new URL(calls[0].url);
    assert.equal(braveUrl.origin + braveUrl.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(calls[0].init.headers['x-subscription-token'], 'test-brave-key');

    // 3. An explicit choice whose own key is missing is "nothing configured" — never a silent fallback to the other
    //    provider's key (BRAVE_SEARCH_API_KEY is still set from step 2), and never a call to either API.
    process.env.SEARCH_PROVIDER = 'tavily';
    delete process.env.TAVILY_API_KEY;
    calls.length = 0;
    respondWith = () => { throw new Error('must never be called: no provider should be configured'); };
    run = await t.start({ branch: 'Zorg', keywords: 'z', filters: { maxQueries: 1 } });
    assert.equal(run.status, 'failed');
    assert.match(run.error, /zoekprovider/);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await t.close();
  }
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

test('a page that inline-lists several procurements (an organisation\'s own "open opdrachten" page, no separate links) yields one record per procurement; a repeated run creates nothing new', async () => {
  const multiHost = 'meerdere-opdrachten.example';
  const sites = { [multiHost]: { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/': { body: MULTI_TENDER_CARDS } } };
  const t = await app({ sites });
  try {
    const run = await t.start({ sourceUrl: `https://${multiHost}/`, runConfig: { maxPages: 1 } });
    assert.equal(run.status, 'succeeded', run.error);
    assert.equal(run.recordsCreated, 4, 'all four procurements on the page are recognised, not merged into one');
    const records = await t.records();
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map(r => r.domain_data.tenderIdentity)).size, 4, 'each has its own identity');
    assert.ok(records.every(r => r.domain_data.sourceUrl.startsWith(`https://${multiHost}/`)), 'the original page URL is kept for every record');
    assert.ok(records.every(r => r.domain_data.discovery.pageSection), 'a human-readable pointer to the specific section is kept');
    const onboarding = records.find(r => r.domain_data.title === 'Onboarding nieuwe leveranciers');
    assert.equal(onboarding.domain_data.referenceNumber, null, 'no reference stated for this one: stays null, never invented');
    assert.ok(onboarding.domain_data.submissionDeadline);

    const after = await t.snapshot();
    const again = await t.start({ sourceUrl: `https://${multiHost}/`, runConfig: { maxPages: 1 } });
    assert.equal(again.recordsCreated, 0, 'recrawling the identical page creates nothing new');
    assert.equal(again.recordsUpdated, 0);
    assert.equal(again.stats.duplicatesUnchanged, 4);
    assert.equal(await t.snapshot(), after, 'the record tables are byte-for-byte identical after the second run');
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
