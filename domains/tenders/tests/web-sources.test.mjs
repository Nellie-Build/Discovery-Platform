import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler, collectFromSource, SourceError } from '@discovery-platform/core';
import { createWebsiteCrawlerSource, createSearchProviderSource, TENDER_SOURCES, mergeTenderPublications } from '../dist/index.js';
import { SITE, DETAIL_BOUW, DETAIL_RFP, GENERAL, MULTI_TENDER_CARDS, page, webTransport, fakeClock, fakeSearchProvider } from './fake-web.mjs';

/** The real crawl engine (legacy, serial) over in-memory websites: robots.txt, sitemap, ranking and page budget all apply. */
const HOST = 'gemeente-voorbeeld.example';
function setup(sites = { [HOST]: SITE }, provider) {
  const { transport, calls } = webTransport(sites);
  const deps = { crawler: createDiscoveryCrawler('legacy'), transport, clock: fakeClock(), ...(provider ? { searchProvider: provider } : {}) };
  return { deps, calls, pageCalls: () => calls.filter(url => !/robots\.txt|sitemap/.test(url)) };
}
const run = (source, filters) => collectFromSource(source, { filters, batchSize: 25, maxItems: 200 });
const paths = items => items.map(item => new URL(item.sourceUrl).pathname).sort();

test('WebsiteCrawlerSource: a homepage crawl finds the concrete tenders and rejects overview, general, event and news pages with a reason', async () => {
  const { deps } = setup();
  const source = createWebsiteCrawlerSource(deps);
  const result = await run(source, { url: `https://${HOST}/` });
  assert.deepEqual(paths(result.items), [
    '/aanbestedingen/onderhoud-groen', '/aanbestedingen/renovatie-basisschool-de-ster', '/aanbestedingen/schilderwerk-sporthal', '/aanbestedingen/security-services',
  ]);
  const stats = source.stats();
  assert.equal(stats.concreteTenders, 4);
  assert.ok(stats.overviewPages >= 1, 'the overview is recognised, not turned into a record');
  assert.ok(stats.generalInformationPages >= 1, 'the supplier-information page is not a tender');
  assert.ok(stats.rejectionReasons.overview_page >= 1);
  assert.ok(stats.rejectionReasons.general_procurement_information >= 1);
  assert.equal(stats.crawlerEngine, 'legacy');
  // Every kind of decision is visible per page.
  const byPath = Object.fromEntries(stats.pageDiagnostics.map(d => [new URL(d.url).pathname, d]));
  assert.equal(byPath['/aanbestedingen'].kind, 'overview');
  assert.equal(byPath['/inkoop/leveranciers'].kind, 'general');
  assert.equal(byPath['/aanbestedingen/security-services'].kind, 'detail');
});

test('WebsiteCrawlerSource: provenance is kept per item (the page URL, how it was found, from which page, the host, the evidence)', async () => {
  const { deps } = setup();
  const result = await run(createWebsiteCrawlerSource(deps), { url: `https://${HOST}` });
  const item = result.items.find(i => i.sourceUrl.endsWith('/security-services'));
  assert.equal(item.sourceUrl, `https://${HOST}/aanbestedingen/security-services`);
  assert.deepEqual({ via: item.raw.discovery.via, host: item.raw.discovery.host, searchProvider: item.raw.discovery.searchProvider }, { via: 'website_crawl', host: HOST, searchProvider: null });
  assert.equal(new URL(item.raw.discovery.discoveredFrom).pathname, '/aanbestedingen', 'found through the overview');
  assert.ok(item.raw.discovery.evidence.includes('deadline') && item.raw.discovery.evidence.includes('reference'));
  const facts = TENDER_SOURCES.website.map(item);
  assert.equal(facts.sourceSystem, 'website');
  assert.equal(facts.referenceNumber, 'RFP-2026-07');
});

test('WebsiteCrawlerSource: a specific tender URL (not the homepage) is crawled and yields that tender with no "discovered from"', async () => {
  const { deps } = setup();
  const result = await run(createWebsiteCrawlerSource(deps), { url: `https://${HOST}/aanbestedingen/security-services`, maxPages: 1 });
  assert.deepEqual(paths(result.items), ['/aanbestedingen/security-services']);
  assert.equal(result.items[0].raw.discovery.discoveredFrom, null);
});

test('WebsiteCrawlerSource: a page is requested at most once per run (robots.txt and sitemap aside)', async () => {
  const { deps, pageCalls } = setup();
  await run(createWebsiteCrawlerSource(deps), { url: `https://${HOST}/` });
  const urls = pageCalls();
  assert.equal(new Set(urls).size, urls.length, `duplicate fetches: ${urls.filter((u, i) => urls.indexOf(u) !== i)}`);
});

test('WebsiteCrawlerSource: the wanted number stops the crawl early; the CPV prefix filters pages that state a different CPV', async () => {
  const one = createWebsiteCrawlerSource(setup().deps);
  const limited = await run(one, { url: `https://${HOST}/`, targetRecords: 1 });
  assert.equal(limited.items.length, 1);
  const source = createWebsiteCrawlerSource(setup().deps);
  const result = await run(source, { url: `https://${HOST}/`, cpvPrefixes: ['45'] });
  const found = paths(result.items);
  assert.ok(found.includes('/aanbestedingen/renovatie-basisschool-de-ster'), 'CPV 45214200 matches 45');
  assert.ok(!found.includes('/aanbestedingen/security-services'), 'CPV 79710000 does not');
  assert.ok(found.includes('/aanbestedingen/schilderwerk-sporthal'), 'a page without CPV stays: unknown is not a mismatch');
  assert.equal(source.stats().filteredByCpv, 1);
  assert.ok(source.stats().cpvUnknown >= 1);
});

test('WebsiteCrawlerSource: an unreachable website is a clear source error, not an empty success', async () => {
  const { deps } = setup({});
  await assert.rejects(() => run(createWebsiteCrawlerSource(deps), { url: 'https://niet-bereikbaar.example/' }), error => error instanceof SourceError && /kon niet worden gecrawld/.test(error.message));
});

test('WebsiteCrawlerSource: invalid URLs and filters are refused before any request', async () => {
  const { deps, calls } = setup();
  const source = createWebsiteCrawlerSource(deps);
  await assert.rejects(() => run(source, {}), /URL van een website/);
  await assert.rejects(() => run(source, { url: 'ftp://x.example' }), /http\(s\)/);
  await assert.rejects(() => run(source, { url: `https://${HOST}/`, cpvPrefixes: ['x'] }), /cpvPrefixes/);
  assert.equal(calls.length, 0);
});

// ─── SearchProviderSource ───────────────────────────────────────────────────────────────────────────────────────────

const search = (extra = {}) => ({ branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'NL', ...extra });
const URLS = {
  detail: `https://${HOST}/aanbestedingen/renovatie-basisschool-de-ster`,
  overview: `https://${HOST}/aanbestedingen`,
  general: `https://${HOST}/inkoop/leveranciers`,
  event: `https://${HOST}/nieuws/workshop`,
};

test('SearchProviderSource: branch, keywords and region are sent as tender-intent queries; country and language go to the provider', async () => {
  const provider = fakeSearchProvider([]);
  const source = createSearchProviderSource(setup(undefined, provider).deps);
  await run(source, search({ maxQueries: 3 }));
  assert.equal(provider.queries.length, 3);
  for (const input of provider.queries) {
    assert.match(input.query, /Bouw renovatie schoolgebouwen Zuid-Holland$/);
    assert.deepEqual([input.country, input.language], ['NL', 'nl']);
  }
  assert.deepEqual(provider.queries.map(q => q.query.split(' ')[0]), ['aanbesteding', 'tender', 'offerteaanvraag']);
});

test('SearchProviderSource: discovers concrete tender pages from search results and rejects everything that is not one, with reasons', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [
    [URLS.detail, 'Aanbesteding renovatie basisschool De Ster', 'openbare aanbesteding renovatie'],
    [URLS.general, 'Informatie voor leveranciers', 'Zo koopt onze organisatie in'],
    [URLS.event, 'Workshop duurzaam bouwen', 'inschrijven'],
    [`https://www.tenderned.nl/aankondigingen/overzicht/1`, 'TenderNed aankondiging', ''],
  ]]]);
  const source = createSearchProviderSource(setup(undefined, provider).deps);
  const result = await run(source, search({ maxQueries: 1, maxOverviewCrawls: 0 }));
  assert.deepEqual(paths(result.items), ['/aanbestedingen/renovatie-basisschool-de-ster']);
  const stats = source.stats();
  assert.equal(stats.concreteTenders, 1);
  assert.equal(stats.apiCoveredSkipped, 1, 'TenderNed/TED pages are found through their own API sources');
  assert.equal(stats.rejectionReasons.general_procurement_information, 1);
  assert.equal(stats.rejectionReasons.insufficient_evidence, 1);
  assert.equal(result.items[0].raw.discovery.via, 'web_search');
  assert.equal(result.items[0].raw.discovery.searchProvider, 'fake');
  assert.match(result.items[0].raw.discovery.query, /^aanbesteding Bouw renovatie schoolgebouwen Zuid-Holland$/);
});

test('SearchProviderSource: source discovery — an overview found by search leads to one brief crawl of that site, which finds the tenders behind it', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [[URLS.overview, 'Aanbestedingen - Gemeente Voorbeeld', 'Lopende aanbestedingen']]]]);
  const { deps } = setup(undefined, provider);
  const source = createSearchProviderSource(deps);
  const result = await run(source, search({ maxQueries: 1 }));
  assert.deepEqual(paths(result.items), [
    '/aanbestedingen/onderhoud-groen', '/aanbestedingen/renovatie-basisschool-de-ster', '/aanbestedingen/schilderwerk-sporthal', '/aanbestedingen/security-services',
  ]);
  assert.equal(source.stats().overviewCrawls, 1);
  assert.ok(result.items.every(item => item.raw.discovery.via === 'web_search'));
});

test('SearchProviderSource: the same URL, however written and however often found, is fetched once; a site is crawled once', async () => {
  const provider = fakeSearchProvider([
    ['aanbesteding', [[URLS.detail, 'a'], [`${URLS.detail}/?utm_source=x#top`, 'a again'], [URLS.overview, 'overzicht'], [`${URLS.overview}?utm_medium=y`, 'overzicht again']]],
    ['tender', [[URLS.detail, 'a'], [`https://www.${HOST}/aanbestedingen/`, 'overzicht via www'], [`https://${HOST}/aanbestedingen/security-services`, 'rfp']]],
  ]);
  const { deps, pageCalls } = setup(undefined, provider);
  const source = createSearchProviderSource(deps);
  const result = await run(source, search({ maxQueries: 2 }));
  const urls = pageCalls().filter(url => !url.includes('www.'));
  assert.equal(new Set(urls).size, urls.length, `fetched twice: ${urls.filter((u, i) => urls.indexOf(u) !== i)}`);
  assert.equal(source.stats().overviewCrawls, 1, 'one crawl for the site however many overview results');
  assert.equal(new Set(result.items.map(i => i.externalId)).size, result.items.length);
});

test('SearchProviderSource: the wanted number and the candidate budget bound the work', async () => {
  const many = Array.from({ length: 12 }, (_, i) => [`https://${HOST}/onbekend/pagina-${i}`, `Pagina ${i}`]);
  const provider = fakeSearchProvider([['aanbesteding', many]]);
  const { deps, pageCalls } = setup(undefined, provider);
  const source = createSearchProviderSource(deps);
  await run(source, search({ maxQueries: 1, maxCandidates: 5 }));
  assert.equal(pageCalls().length, 5);
  assert.equal(source.stats().candidatesFetched, 5);
});

test('SearchProviderSource: no provider configured is a plain, actionable error; a provider that fails on every query is a source error; one failing query is not fatal', async () => {
  await assert.rejects(() => run(createSearchProviderSource(setup().deps), search()), error => error instanceof SourceError && error.code === 'invalid_filters' && /zoekprovider/.test(error.message));
  const failing = { async search() { throw new Error('Brave Search-aanroep mislukt (status 429).'); } };
  await assert.rejects(() => run(createSearchProviderSource(setup(undefined, failing).deps), search()), /status 429/);
  let calls = 0;
  const flaky = { async search(input) { if (calls++ === 0) throw new Error('boom'); return [{ url: URLS.detail, title: 'x', snippet: null, source: 'flaky' }]; } };
  const source = createSearchProviderSource(setup(undefined, flaky).deps);
  const result = await run(source, search({ maxQueries: 2 }));
  assert.equal(result.items.length, 1);
  assert.equal(source.stats().queryErrors, 1);
});

test('SearchProviderSource: requires a branch or keywords', async () => {
  await assert.rejects(() => run(createSearchProviderSource(setup(undefined, fakeSearchProvider([])).deps), { country: 'NL' }), /branche of zoektermen/);
});

test('two different websites with the same tender text stay two tenders: identity is the page, never the title', async () => {
  const sites = { [HOST]: { '/aanbestedingen/x': { body: DETAIL_BOUW } }, 'ziekenhuis-voorbeeld.example': { '/tenders/x': { body: DETAIL_BOUW } } };
  const provider = fakeSearchProvider([['aanbesteding', [[`https://${HOST}/aanbestedingen/x`, 'a'], ['https://ziekenhuis-voorbeeld.example/tenders/x', 'b']]]]);
  const { deps } = setup(sites, provider);
  const result = await run(createSearchProviderSource(deps), search({ maxQueries: 1 }));
  assert.equal(result.items.length, 2);
  const tenders = mergeTenderPublications(result.items.map(item => TENDER_SOURCES.search.map(item)));
  assert.equal(tenders.length, 2);
  assert.ok(page && DETAIL_RFP && GENERAL);
});

// ─── Inline multi-tender pages through the real sources (WebsiteCrawlerSource / SearchProviderSource) ────────────────

const MULTI_HOST = 'meerdere-opdrachten.example';
function multiSite(overrides = {}) {
  return { [MULTI_HOST]: { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/': { body: MULTI_TENDER_CARDS }, ...overrides } };
}

test('WebsiteCrawlerSource: a page that inline-lists several procurements yields one SourceItem per procurement, each with its own URL and identity', async () => {
  const { deps } = setup(multiSite());
  const source = createWebsiteCrawlerSource(deps);
  const result = await run(source, { url: `https://${MULTI_HOST}/`, maxPages: 1 });
  assert.equal(result.items.length, 4);
  assert.equal(new Set(result.items.map(i => i.externalId)).size, 4, 'every item has its own identity');
  assert.deepEqual(new Set(result.items.map(i => new URL(i.sourceUrl).pathname)), new Set(['/']), 'the original page URL is kept for every item');
  assert.ok(result.items.every(i => i.sourceUrl.includes('#')), 'each item also keeps its own section anchor');
  const facts = result.items.map(item => TENDER_SOURCES.website.map(item));
  assert.equal(new Set(facts.map(f => f.tenderIdentity)).size, 4);
  assert.ok(facts.every(f => f.referenceNumber === null || /^[A-Za-z0-9./_-]+$/.test(f.referenceNumber)), 'no fabricated reference values');
  assert.equal(source.stats().multiItemPages, 1);
  assert.equal(source.stats().concreteTenders, 4);
});

test('WebsiteCrawlerSource: a page is fetched once even though it yields several items; recrawling the same site (a fresh run) gives back the identical identities', async () => {
  const { deps, pageCalls } = setup(multiSite());
  const first = await run(createWebsiteCrawlerSource(deps), { url: `https://${MULTI_HOST}/`, maxPages: 1 });
  assert.equal(pageCalls().length, 1, 'one physical fetch of the page, however many items it yielded');
  const { deps: deps2 } = setup(multiSite());
  const again = await run(createWebsiteCrawlerSource(deps2), { url: `https://${MULTI_HOST}/`, maxPages: 1 });
  assert.deepEqual(again.items.map(i => i.externalId).sort(), first.items.map(i => i.externalId).sort());
});

test('SearchProviderSource: a search result that inline-lists several procurements yields one item per procurement, with search provenance on each', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [[`https://${MULTI_HOST}/`, 'Open opdrachten']]]]);
  const { deps } = setup(multiSite(), provider);
  const source = createSearchProviderSource(deps);
  const result = await run(source, { branch: 'Bouw', keywords: 'technische bijstand', maxQueries: 1 });
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every(item => item.raw.discovery.via === 'web_search' && item.raw.discovery.pageSection));
  assert.equal(new Set(result.items.map(i => i.raw.discovery.pageSection)).size, 4, 'each item keeps its own section as a human-readable pointer');
  assert.equal(source.stats().multiItemPages, 1);
});
