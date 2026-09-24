import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { load } from 'cheerio';
import { assessTenderPage, classifySourceRole, hostRole, namesMatch, hostMatchesPublisher, createWebsiteCrawlerSource, createSearchProviderSource, TENDER_SOURCES } from '../dist/index.js';
import { createDiscoveryCrawler, collectFromSource } from '@discovery-platform/core';
import { SITE, PLATFORM_SITE, PLATFORM_HOST, DETAIL_BOUW, page, webTransport, fakeClock, fakeSearchProvider } from './fake-web.mjs';

const role = over => classifySourceRole({ host: 'site.example', publisher: null, authority: null, selfDescription: '', firstPersonProcurement: false, ...over });
const assess = (html, host = 'gemeente-voorbeeld.example', p = '/aanbestedingen/voorbeeld-opdracht') => assessTenderPage({ $: load(html), url: `https://${host}${p}` });

// ─── source role: general signals, never a hostname ─────────────────────────────────────────────────────────────────

test('official organisation site: the publisher is the contracting authority', () => {
  const result = role({ host: 'gemeente-voorbeeld.example', publisher: 'Gemeente Voorbeeld', authority: 'Gemeente Voorbeeld' });
  assert.equal(result.role, 'official_organization_site');
  assert.equal(result.confidence, 'high');
  assert.ok(result.evidence.includes('authority_matches_publisher'));
});

test('official organisation site, medium confidence: the domain is named after the publisher and the text speaks of its own procurements', () => {
  const result = role({ host: 'www.hunzeenaas.example', publisher: "Waterschap Hunze en Aa's", firstPersonProcurement: true });
  assert.deepEqual([result.role, result.confidence], ['official_organization_site', 'medium']);
  assert.deepEqual(result.evidence.sort(), ['domain_named_after_publisher', 'first_person_procurement_text']);
});

test('aggregator: the site presents itself as a tender platform, or the authority differs from the publisher', () => {
  const selfDescribed = role({ selfDescription: 'Alle actuele aanbestedingen op één plek. Tenderplatform voor leveranciers.' });
  assert.equal(selfDescribed.role, 'aggregator');
  assert.ok(selfDescribed.evidence.includes('presents_itself_as_tender_platform'));
  const other = role({ publisher: 'Marktplein Nederland', authority: 'Gemeente Voorbeeld' });
  assert.deepEqual([other.role, other.confidence], ['aggregator', 'medium']);
  assert.ok(other.evidence.includes('authority_differs_from_publisher'));
  assert.equal(role({ publisher: 'Tender Service Nederland' }).role, 'aggregator');
  assert.equal(role({ publisher: 'Gemeente Voorbeeld', authority: 'Gemeente Voorbeeld', siteName: 'Tender Portaal', selfDescription: 'Tenderplatform' }).role, 'aggregator', 'the site name and self-description outweigh a publisher that equals the buyer');
});

test('unknown when the evidence is thin: no aggressive guess', () => {
  assert.deepEqual(role({}), { role: 'unknown_web_source', confidence: 'low', evidence: [] });
  assert.equal(role({ host: 'gemeente-voorbeeld.example', publisher: 'Gemeente Voorbeeld' }).role, 'unknown_web_source', 'a matching domain alone is one point, not enough');
  assert.equal(role({ firstPersonProcurement: true }).role, 'unknown_web_source');
});

test('no hostname hardcoding: identical evidence gives the identical role on any host', () => {
  const input = { publisher: 'Marktplein Nederland', authority: 'Gemeente Voorbeeld', selfDescription: 'Aanbestedingsplatform' };
  const results = ['tender.app', 'gemeente-voorbeeld.nl', 'bedrijf-x.nl', 'nieuw-portaal.example'].map(host => role({ ...input, host }));
  assert.ok(results.every(result => result.role === 'aggregator' && result.confidence === results[0].confidence));
  const official = ['tender.app', 'bedrijf-x.nl'].map(host => role({ host, publisher: 'Bedrijf X', authority: 'Bedrijf X' }).role);
  assert.deepEqual(official, ['official_organization_site', 'official_organization_site']);
});

test('the domain code contains no hostname of any website (only the two API sources the module itself integrates)', async () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const name of ['source-role.ts', 'tender-page.ts', 'tender-rank.ts', 'tender-search.ts']) {
    const code = (await readFile(path.join(src, name), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const literals = code.match(/(['"`])(?:(?!\1).)*\1/g) ?? [];
    assert.equal(literals.some(text => /\b[a-z0-9-]+\.(?:nl|com|eu|app|ai|org|net|io)\b/i.test(text)), false, `${name} names a host`);
  }
  const web = (await readFile(path.join(src, 'web-sources.ts'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hosts = [...web.matchAll(/\b([a-z0-9-]+(?:\\\.[a-z0-9-]+|\.[a-z]{2,})+)\b/gi)].map(m => m[1].replace(/\\/g, '')).filter(h => /\.(?:nl|eu)$/.test(h));
  assert.deepEqual([...new Set(hosts)].sort(), ['ted.europa.eu', 'tenderned.nl']);
});

test('organisation names match by their significant words; a domain label matches its publisher', () => {
  assert.equal(namesMatch('Gemeente Voorbeeld', 'Voorbeeld'), true);
  assert.equal(namesMatch('Gemeente Rotterdam', 'Gemeente Delft'), false, 'the generic word "gemeente" alone never matches');
  assert.equal(namesMatch(null, 'Gemeente Delft'), false);
  assert.equal(hostMatchesPublisher('www.hunzeenaas.nl', "Waterschap Hunze en Aa's"), true);
  assert.equal(hostMatchesPublisher('tender.example', 'Gemeente Voorbeeld'), false);
});

test('a host that shows three or more different contracting authorities is an aggregator whatever its pages said', () => {
  const official = { role: 'official_organization_site', confidence: 'high', evidence: ['x'] };
  assert.equal(hostRole([official], ['Gemeente Alpha', 'Gemeente Alpha']).role, 'official_organization_site');
  const many = hostRole([official], ['Gemeente Alpha', 'Waterschap Beta', 'Provincie Gamma']);
  assert.equal(many.role, 'aggregator');
  assert.match(many.evidence[0], /3_different_contracting_authorities/);
  assert.equal(hostRole([], []).role, 'unknown_web_source');
});

// ─── contracting authority: precedence, and never the site ─────────────────────────────────────────────────────────

test('authority: explicit label (dl and table), labeled sentence, JSON-LD and meta each work, in that precedence', () => {
  const label = assess(DETAIL_BOUW);
  assert.deepEqual([label.facts.contractingAuthority, label.authoritySource], ['Gemeente Voorbeeld', 'label']);
  const ld = { '@context': 'https://schema.org', '@type': 'Event', name: 'x', buyer: { '@type': 'Organization', name: 'Gemeente Structured' } };
  const body = '<h1>Aanbesteding renovatie</h1><dl><dt>Opdrachtgever</dt><dd>Gemeente Label</dd><dt>Kenmerk</dt><dd>AB-100</dd><dt>Sluitingsdatum</dt><dd>1 december 2026</dd></dl>';
  const structured = assess(page('Aanbesteding', body, `<script type="application/ld+json">${JSON.stringify(ld)}</script>`));
  assert.deepEqual([structured.facts.contractingAuthority, structured.authoritySource], ['Gemeente Structured', 'structured'], 'structured data wins over the label');
  const meta = assess(page('Aanbesteding', body, '<meta name="contracting-authority" content="Gemeente Meta">'));
  assert.deepEqual([meta.facts.contractingAuthority, meta.authoritySource], ['Gemeente Meta', 'structured']);
  const prose = assess(page('Aanbesteding', '<h1>Aanbesteding schoonmaak</h1><p>De aanbestedende dienst is Gemeente Prosa. Kenmerk: SC-2026-9. Sluitingsdatum: 3 december 2026.</p>'));
  assert.deepEqual([prose.facts.contractingAuthority, prose.authoritySource], ['Gemeente Prosa', 'prose_label']);
  const english = assess(page('Tender', '<h1>Request for Proposal cleaning</h1><table><tr><th>Contracting entity</th><td>Municipality of Example</td></tr><tr><th>Reference</th><td>RFP-9</td></tr><tr><th>Deadline</th><td>3 December 2026</td></tr></table>'));
  assert.equal(english.facts.contractingAuthority, 'Municipality of Example');
});

test('authority: an aggregator publisher is never the contracting authority; publisher and authority stay separate', () => {
  const html = page('Aanbesteding schoonmaak kantoren', '<h1>Aanbesteding schoonmaak kantoren</h1><dl><dt>Opdrachtgever</dt><dd>Gemeente Alpha</dd><dt>Kenmerk</dt><dd>PL-1</dd><dt>Sluitingsdatum</dt><dd>15 december 2026</dd></dl>', '<meta property="og:site_name" content="Tenderplatform Nederland">');
  const result = assess(html, 'tender-platform.example');
  assert.equal(result.facts.contractingAuthority, 'Gemeente Alpha');
  assert.equal(result.role.role, 'aggregator');
});

test('authority: the site name / publisher is NOT taken as authority, on any kind of site; a missing authority stays null', () => {
  const body = '<h1>Aanbesteding schilderwerk sporthal</h1><p>Uiterlijk indienen: 20-11-2026.</p><a href="/x.pdf">Bestek</a>';
  for (const head of ['<meta property="og:site_name" content="Een Aggregator">', '<script type="application/ld+json">{"@type":"Organization","name":"Gemeente Zelf"}</script>',
    '<script type="application/ld+json">{"@type":"WebPage","publisher":{"@type":"Organization","name":"Uitgever BV"}}</script>']) {
    const result = assess(page('Offerte', body, head));
    assert.equal(result.kind, 'detail');
    assert.equal(result.facts.contractingAuthority, null, head);
    assert.equal(result.authoritySource, null);
    assert.ok(result.publisher, 'the publisher is still known, as its own concept');
  }
  assert.equal(assess(page('Offerte', body)).publisher, 'Gemeente Voorbeeld', 'publisher from the site metadata');
});

test('authority: placeholders, dates and whole sentences under an authority label are rejected', () => {
  const withAuthority = value => assess(page('Aanbesteding', `<h1>Aanbesteding x</h1><dl><dt>Opdrachtgever</dt><dd>${value}</dd><dt>Kenmerk</dt><dd>AB-1</dd><dt>Sluitingsdatum</dt><dd>3 december 2026</dd></dl>`)).facts.contractingAuthority;
  assert.equal(withAuthority('n.v.t.'), null);
  assert.equal(withAuthority('12 november 2026'), null);
  assert.equal(withAuthority('Deze opdracht wordt uitgevoerd in opdracht van een van de gemeenten in de regio en meer tekst erbij'), null);
  assert.equal(withAuthority('Gemeente Echt'), 'Gemeente Echt');
});

// ─── role and provenance through the sources ──────────────────────────────────────────────────────────────────────

const HOST = 'gemeente-voorbeeld.example';
function setup(sites, provider) {
  const { transport, calls } = webTransport(sites);
  return { calls, deps: { crawler: createDiscoveryCrawler('legacy'), transport, clock: fakeClock(), ...(provider ? { searchProvider: provider } : {}) } };
}
const run = (source, filters) => collectFromSource(source, { filters, batchSize: 25, maxItems: 200 });

test('website crawl of an aggregator: three different buyers on one host make it an aggregator with the buyer kept apart from the publisher', async () => {
  const { deps } = setup({ [PLATFORM_HOST]: { ...PLATFORM_SITE, '/': { body: page('Home', '<a href="/tenders/schoonmaak-kantoren">a</a><a href="/tenders/groenonderhoud-park">b</a><a href="/tenders/vervanging-verlichting">c</a>') } } });
  const source = createWebsiteCrawlerSource(deps);
  const result = await run(source, { url: `https://${PLATFORM_HOST}/` });
  assert.equal(result.items.length, 3);
  for (const item of result.items) {
    const d = item.raw.discovery;
    assert.deepEqual([d.sourceRole, d.publisher, d.mode], ['aggregator', 'Tenderplatform Nederland', undefined]);
    assert.equal(d.authoritySource, 'label');
    const facts = TENDER_SOURCES.website.map(item);
    assert.notEqual(facts.contractingAuthority, d.publisher);
  }
  assert.deepEqual(new Set(result.items.map(i => i.raw.assessment.facts.contractingAuthority)), new Set(['Gemeente Alpha', 'Waterschap Beta', 'Provincie Gamma']));
  assert.deepEqual(source.stats().sourceRoles, { official_organization_site: 0, aggregator: 1, unknown_web_source: 0 });
});

test('website crawl of an organisation site: official role, publisher known, evidence kept', async () => {
  const { deps } = setup({ [HOST]: SITE });
  const source = createWebsiteCrawlerSource(deps);
  const result = await run(source, { url: `https://${HOST}/` });
  assert.ok(result.items.length >= 4);
  assert.ok(result.items.every(i => i.raw.discovery.sourceRole === 'official_organization_site' && i.raw.discovery.publisher === 'Gemeente Voorbeeld'));
  assert.deepEqual(source.stats().sourceRoles, { official_organization_site: 1, aggregator: 0, unknown_web_source: 0 });
  assert.equal(source.stats().hostRoles[HOST].role, 'official_organization_site');
});

test('search: the role of every host is counted once, and each tender carries its host role', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [
    [`https://${PLATFORM_HOST}/tenders/schoonmaak-kantoren`, 'a'], [`https://${PLATFORM_HOST}/tenders/groenonderhoud-park`, 'b'], [`https://${PLATFORM_HOST}/tenders/vervanging-verlichting`, 'c'],
    [`https://${HOST}/aanbestedingen/renovatie-basisschool-de-ster`, 'd'],
  ]]]);
  const { deps } = setup({ [HOST]: SITE, [PLATFORM_HOST]: PLATFORM_SITE }, provider);
  const source = createSearchProviderSource(deps);
  const result = await run(source, { branch: 'Bouw', keywords: 'renovatie', maxQueries: 1 });
  const byHost = Object.fromEntries(result.items.map(i => [i.raw.discovery.host, i.raw.discovery.sourceRole]));
  assert.deepEqual(byHost, { [PLATFORM_HOST]: 'aggregator', [HOST]: 'official_organization_site' });
  assert.deepEqual(source.stats().sourceRoles, { official_organization_site: 1, aggregator: 1, unknown_web_source: 0 });
});

// ─── robots.txt for the search step ───────────────────────────────────────────────────────────────────────────────

test('search: a result that robots.txt forbids is not requested; the others are, and robots.txt is read once per origin', async () => {
  const sites = { [HOST]: { ...SITE, '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /aanbestedingen/security-services' } } };
  const provider = fakeSearchProvider([['aanbesteding', [
    [`https://${HOST}/aanbestedingen/security-services`, 'rfp'], [`https://${HOST}/aanbestedingen/renovatie-basisschool-de-ster`, 'bouw'], [`https://${HOST}/aanbestedingen/schilderwerk-sporthal`, 'verf'],
  ]]]);
  const { deps, calls } = setup(sites, provider);
  const source = createSearchProviderSource(deps);
  const result = await run(source, { branch: 'Bouw', maxQueries: 1, maxOverviewCrawls: 0 });
  assert.deepEqual(result.items.map(i => new URL(i.sourceUrl).pathname).sort(), ['/aanbestedingen/renovatie-basisschool-de-ster', '/aanbestedingen/schilderwerk-sporthal']);
  assert.ok(!calls.some(url => url.endsWith('/security-services')), 'the forbidden page was never requested');
  assert.equal(calls.filter(url => url.endsWith('/robots.txt')).length, 1);
  assert.equal(source.stats().robotsBlocked, 1);
  assert.equal(source.stats().rejectionReasons.robots_blocked, 1);
});

test('search: an unreadable robots.txt blocks the origin (fail closed, like the crawl); a missing one allows it', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [[`https://${HOST}/aanbestedingen/renovatie-basisschool-de-ster`, 'a']]]]);
  const broken = setup({ [HOST]: { ...SITE, '/robots.txt': { status: 500, body: '' } } }, provider);
  const blocked = await run(createSearchProviderSource(broken.deps), { branch: 'Bouw', maxQueries: 1 });
  assert.equal(blocked.items.length, 0);
  const { '/robots.txt': _omit, ...noRobots } = SITE;
  const open = setup({ [HOST]: noRobots }, provider);
  assert.equal((await run(createSearchProviderSource(open.deps), { branch: 'Bouw', maxQueries: 1 })).items.length, 1);
});

test('the default search transport keeps the SSRF guard: a private address is refused before any connection', async () => {
  const provider = fakeSearchProvider([['aanbesteding', [['http://127.0.0.1:9/informatie-pagina', 'lokaal'], ['http://169.254.169.254/latest/meta-data', 'metadata']]]]);
  const source = createSearchProviderSource({ crawler: createDiscoveryCrawler('legacy'), searchProvider: provider });
  const result = await run(source, { branch: 'Bouw', maxQueries: 1, maxOverviewCrawls: 0 });
  assert.equal(result.items.length, 0);
  assert.equal(source.stats().robotsBlocked, 2, 'both addresses are refused at the robots step, which uses the SSRF-safe transport');
});

test('authority: a label element followed by its value element (a grid, no dl or table) is read like a label pair', () => {
  const grid = assess(page('Aanbesteding', '<h1>Aanbesteding renovatie kantoor</h1><div><span>Opdrachtgever</span><span>Rijksvastgoedbedrijf</span></div><div><span>Kenmerk</span><span>RVB-2026-11</span></div><div><span>Sluitingsdatum</span><span>7 september 2026</span></div>'));
  assert.equal(grid.kind, 'detail');
  assert.deepEqual([grid.facts.contractingAuthority, grid.facts.referenceNumber, grid.facts.submissionDeadline], ['Rijksvastgoedbedrijf', 'RVB-2026-11', '2026-09-07']);
  assert.equal(grid.authoritySource, 'label');
});

test('authority: a label with an icon and a value that is a link still pair up', () => {
  const html = page('Aanbesteding', '<h1>Aanbesteding renovatie kantoor</h1><div class="cell"><div class="cap"><svg width="16"><path d="M0 0"/></svg>Opdrachtgever</div><div class="val"><a href="/organisaties/x">Rijksvastgoedbedrijf</a></div><div class="sub">Zuid-Holland</div></div><dl><dt>Kenmerk</dt><dd>RVB-1</dd><dt>Sluitingsdatum</dt><dd>7 september 2026</dd></dl>');
  assert.equal(assess(html).facts.contractingAuthority, 'Rijksvastgoedbedrijf');
});

test('weak self-referential signals (domain named after the site, "we" text) never outweigh a tender-platform site', () => {
  const result = role({ host: 'tenderview.example', publisher: 'Rijksvastgoedbedrijf', siteName: 'TenderView', authority: 'Rijksvastgoedbedrijf', selfDescription: 'Aanbestedingen TenderKalender Tender-monitoring', firstPersonProcurement: true });
  assert.equal(result.role, 'aggregator');
  assert.ok(!result.evidence.includes('domain_named_after_publisher') && !result.evidence.includes('first_person_procurement_text'));
});
