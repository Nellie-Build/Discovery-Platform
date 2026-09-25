import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import {
  interpretDescription, parseCriteria, summarizeCriteria, buildCompanySearchQueries, excludedHostKind, registrableDomain,
  createCompanySearchSource, createCompanyWebsiteSource, buildCompanyProfile, evaluateCompany, looksLikeCompanySite, updateStoredCompany, EMPTY_CRITERIA,
} from '../dist/index.js';
import { SITES, SECURITY_RESULTS, webTransport, fakeClock, fakeSearchProvider } from './fake-companies.mjs';

const criteria = over => ({ ...EMPTY_CRITERIA, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [], provinces: [], places: [], exclusions: [], ...over });
const deps = (sites = SITES, provider) => { const { transport, calls } = webTransport(sites); return { deps: { crawler: createDiscoveryCrawler('legacy'), transport, clock: fakeClock(), searchProvider: provider }, calls }; };
const CHECKED = '2026-09-25T10:00:00.000Z';
async function profileOf(url, c = criteria({})) {
  const { deps: d } = deps();
  const { items } = await createCompanyWebsiteSource(d).fetchBatch({ cursor: null, limit: 1, filters: { url, ...c, pagesPerCompany: 12 } });
  const raw = items[0].raw;
  return { raw, facts: buildCompanyProfile(raw.pages, { website: raw.website, via: 'website', query: null, searchProvider: null, searchSnippet: null, mode: 'website', checkedAt: CHECKED }) };
}

// ─── Interpretation ─────────────────────────────────────────────────────────────────────────────────────────────────

test('a description becomes editable criteria; IN a sector (branch) differs from supplying TO a sector (customer)', () => {
  const r = interpretDescription('Ik zoek bedrijven in Nederland die camerasystemen installeren en ervaring hebben met ziekenhuizen.');
  assert.deepEqual({ i: r.criteria.industries, p: r.criteria.products, s: r.criteria.services, c: r.criteria.customerSectors, country: r.criteria.country },
    { i: ['beveiliging'], p: ['camerasystemen'], s: ['installatie'], c: ['ziekenhuizen'], country: 'NL' });
  assert.ok(r.recognized.find(x => x.kind === 'industry').inferred, 'the branch is derived from the product and shown as such');
  assert.deepEqual(interpretDescription('zorgorganisaties in Den Haag').criteria.industries, ['zorg']);
  assert.deepEqual(interpretDescription('zorgorganisaties in Den Haag').criteria.places, ['Den Haag']);
  const supply = interpretDescription('ICT-bedrijven die planningssoftware maken voor zorginstellingen').criteria;
  assert.deepEqual([supply.industries, supply.products, supply.customerSectors], [['ICT'], ['planningssoftware'], ['zorginstellingen']]);
  const roles = interpretDescription('groothandels die beveiligingsproducten leveren aan installateurs').criteria;
  assert.deepEqual([roles.roles, roles.customerSectors], [['wholesaler'], ['installateurs']], '"aan installateurs" is who they supply, not their role');
});

test('synonyms, provinces, specialisations, exclusions and unrecognised words are handled transparently', () => {
  const r = interpretDescription('beveiligingsbedrijven in Zuid-Holland die CCTV installeren voor zorginstellingen, geen alarmsystemen');
  assert.deepEqual(r.criteria.products, ['camerasystemen'], 'CCTV is the camera systems concept');
  assert.deepEqual(r.criteria.provinces, ['NL-ZH']);
  assert.deepEqual(r.criteria.exclusions, ['alarmsystemen']);
  assert.ok(!r.criteria.products.includes('alarmsystemen'));
  assert.deepEqual(interpretDescription('bouwbedrijven gespecialiseerd in renovatie van scholen').criteria.specialisations, ['schoolrenovatie']);
  assert.deepEqual(interpretDescription('bedrijven actief in industriële automatisering in Noord-Brabant').criteria.specialisations, ['industriele automatisering']);
  assert.deepEqual(interpretDescription('leveranciers van heftrucks').unrecognized, ['heftrucks'], 'an unknown word is listed, never silently used');
  assert.match(summarizeCriteria(r.criteria), /Product: camerasystemen · Dienst: installatie · Afnemer: zorginstellingen · Zuid-Holland · Niet: alarmsystemen/);
});

test('criteria are validated with messages a user can act on', () => {
  assert.throws(() => parseCriteria({ country: 'Duitsland' }), /alleen naar bedrijven in Nederland/);
  assert.throws(() => parseCriteria({ roles: ['astronaut'] }), /Onbekende bedrijfsrol/);
  assert.throws(() => parseCriteria({ provinces: ['Atlantis'] }), /Onbekende provincie/);
  assert.throws(() => parseCriteria({ products: Array.from({ length: 11 }, (_, i) => `p${i}`) }), /hoogstens 10/);
  const ok = parseCriteria({ products: 'camerasystemen, toegangscontrole', provinces: ['Zuid-Holland'], places: ['den haag'], roles: ['installateur'] });
  assert.deepEqual([ok.products, ok.provinces, ok.places, ok.roles], [['camerasystemen', 'toegangscontrole'], ['NL-ZH'], ['Den Haag'], ['installer']]);
});

test('search queries are few and targeted; directories, social media and news hosts are never companies', () => {
  const queries = buildCompanySearchQueries(criteria({ industries: ['beveiliging'], products: ['camerasystemen'], services: ['installatie'], customerSectors: ['zorginstellingen'], provinces: ['NL-ZH'] }), 4);
  assert.equal(queries.length, 4);
  assert.equal(queries[0].query, 'camerasystemen installatie voor zorginstellingen Zuid-Holland');
  assert.ok(queries.some(q => /camerabewaking|cctv|videobewaking/.test(q.query)), 'a synonym angle');
  for (const host of ['www.bedrijvenpagina.nl', 'nl.linkedin.com', 'www.werkspot.nl', 'www.nu.nl', 'www.google.nl', 'maps.example.com']) assert.ok(excludedHostKind(host), host);
  assert.equal(excludedHostKind('www.veilig-zuid.example'), null);
});

// ─── Profiles and evidence ──────────────────────────────────────────────────────────────────────────────────────────

test('a company site becomes a profile with sourced activities, establishment vs service area, and general contact only', async () => {
  const { facts } = await profileOf('https://www.veilig-zuid.example/');
  assert.equal(facts.identity, 'veilig-zuid.example');
  assert.equal(facts.name, 'Veilig Zuid B.V.');
  assert.ok(facts.tradeNames.includes('Veilig Zuid'));
  assert.match(facts.description, /installeert en onderhoudt camerasystemen/);
  assert.ok(facts.products.find(a => a.conceptId === 'cctv' && a.strength === 'strong'));
  assert.ok(facts.services.find(a => a.conceptId === 'installation' && a.strength === 'strong'));
  const care = facts.customerSectors.find(a => a.conceptId === 'care_institutions');
  assert.equal(care.strength, 'strong');
  assert.ok(care.evidence.some(e => e.url.endsWith('/sectoren') && /voor zorginstellingen/.test(e.quote)));
  assert.ok(facts.roles.some(r => r.role === 'installer'));
  assert.ok(!facts.roles.some(r => r.role === 'wholesaler'), '"werken samen met groothandels" is not its own role');
  assert.deepEqual(facts.locations.map(l => [l.city, l.province]), [['Rotterdam', 'NL-ZH']], 'the Leiden project address is not an establishment');
  assert.ok(facts.serviceAreas.some(a => a.scope === 'province' && a.value === 'NL-ZH'));
  assert.equal(facts.phone, '0101234567');
  assert.equal(facts.email, 'info@veilig-zuid.example', 'a personal address is never stored');
  assert.match(facts.contactUrl, /\/contact$/);
  assert.deepEqual(facts.registration, { kvkNumber: null, statedKvkNumber: '12345678', statedOn: facts.registration.statedOn });
  assert.ok(facts.sources.every(s => s.type === 'official_website' && s.checkedAt === CHECKED));
  assert.ok(!facts.sources.some(s => s.url.endsWith('/nieuws')), 'news pages are never used as evidence');
});

test('match status per criterion: confirmed with specific evidence, possible on a passing mention, insufficient without', async () => {
  const c = criteria({ products: ['camerasystemen'], services: ['installatie'], customerSectors: ['ziekenhuizen'], provinces: ['NL-ZH'] });
  const { facts: installer } = await profileOf('https://www.veilig-zuid.example/', c);
  const good = evaluateCompany(installer, c, CHECKED);
  assert.equal(good.status, 'confirmed');
  assert.ok(good.matches.every(m => m.status === 'confirmed' && m.sourceUrl && m.checkedAt === CHECKED), JSON.stringify(good.matches));
  assert.equal(good.matches.find(m => m.kind === 'province').found, 'Vestiging in Rotterdam');

  const { facts: shop } = await profileOf('https://camerashop.example/', c);
  const weak = evaluateCompany(shop, c, CHECKED);
  const hospital = weak.matches.find(m => m.kind === 'customer_sector');
  assert.notEqual(hospital.status, 'confirmed', 'a hospital mentioned in passing is no evidence of supplying hospitals');
  assert.equal(weak.matches.find(m => m.kind === 'province').status, 'possible', 'national delivery is not a location in Zuid-Holland');
  assert.equal(weak.status, 'possible');
  assert.equal(evaluateCompany(shop, criteria({ services: ['onderhoud'], specialisations: ['utiliteitsbouw'] }), CHECKED).status, 'insufficient');
});

test('geography: no false matches from a city, a national service area, a project location or a .nl domain', async () => {
  const { facts: installer } = await profileOf('https://www.veilig-zuid.example/');
  const place = evaluateCompany(installer, criteria({ products: ['camerasystemen'], places: ['Den Haag'] }), CHECKED).matches.find(m => m.kind === 'place');
  assert.equal(place.status, 'possible', 'Rotterdam is in the same province as Den Haag, not in Den Haag');
  const leiden = evaluateCompany(installer, criteria({ products: ['camerasystemen'], places: ['Leiden'] }), CHECKED).matches.find(m => m.kind === 'place');
  assert.notEqual(leiden.status, 'confirmed', 'a customer project in Leiden is not a location in Leiden');
  const brabant = evaluateCompany(installer, criteria({ products: ['camerasystemen'], provinces: ['NL-NB'] }), CHECKED).matches.find(m => m.kind === 'province');
  assert.equal(brabant.status, 'insufficient');
  assert.match(brabant.note, /Rotterdam/);
  const noAddress = { ...installer, locations: [], serviceAreas: [], domain: 'voorbeeld.nl' };
  assert.equal(evaluateCompany(noAddress, criteria({ products: ['camerasystemen'] }), CHECKED).matches.find(m => m.kind === 'country').status, 'insufficient');
});

test('unknown stays unknown; a page without company signals is not a company; exclusions remove a company', async () => {
  const { facts: bouw } = await profileOf('https://www.delftse-bouw.example/');
  assert.equal(bouw.email, null);
  assert.equal(bouw.registration.statedKvkNumber, null);
  assert.deepEqual(bouw.locations.map(l => l.city), ['Delft']);
  assert.ok(bouw.specialisations.some(s => s.conceptId === 'school_renovation'));
  const { raw } = await profileOf('https://beveiligingsnieuws.example/');
  assert.equal(looksLikeCompanySite(raw.pages), false);
  const { facts: installer } = await profileOf('https://www.veilig-zuid.example/');
  assert.equal(evaluateCompany(installer, criteria({ products: ['camerasystemen'], exclusions: ['toegangscontrole'] }), CHECKED).excludedBy, 'toegangscontrole');
});

// ─── Identity and updates ───────────────────────────────────────────────────────────────────────────────────────────

test('identity is the registrable domain, never the name; updates keep earlier evidence and log changes', async () => {
  assert.equal(registrableDomain('www.shop.voorbeeld.nl'), 'voorbeeld.nl');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  const { facts } = await profileOf('https://www.veilig-zuid.example/');
  const same = updateStoredCompany(facts, { ...facts, lastCheckedAt: '2026-10-01T00:00:00.000Z', sources: facts.sources.map(s => ({ ...s, checkedAt: '2026-10-01T00:00:00.000Z' })) });
  assert.equal(same.changed, false, 'only the check date differs');
  const later = { ...facts, lastCheckedAt: '2026-10-01T00:00:00.000Z', name: 'Veilig Zuid Groep B.V.', phone: null, products: facts.products.filter(p => p.conceptId !== 'cctv'),
    services: [...facts.services, { kind: 'service', conceptId: 'monitoring', label: 'alarmopvolging', strength: 'strong', evidence: [{ url: 'https://www.veilig-zuid.example/meldkamer', pageType: 'services', quote: 'Eigen meldkamer' }] }] };
  const update = updateStoredCompany(facts, later);
  assert.equal(update.changed, true);
  assert.ok(update.facts.products.some(p => p.conceptId === 'cctv'), 'evidence found earlier is never dropped');
  assert.ok(update.facts.services.some(s => s.conceptId === 'monitoring'));
  assert.equal(update.facts.phone, '0101234567', 'a value not found again is kept');
  assert.deepEqual(update.facts.changes.map(c => [c.field, c.previous, c.current]), [['name', 'Veilig Zuid B.V.', 'Veilig Zuid Groep B.V.']]);
});

// ─── Sources: search route, budgets and failures ───────────────────────────────────────────────────────────────────

test('route A: searches, skips non-company hosts, reads each candidate company once, and reports a site that failed', async () => {
  const provider = fakeSearchProvider([['camera', SECURITY_RESULTS]]);
  const { deps: d, calls } = deps(SITES, provider);
  const source = createCompanySearchSource(d);
  const { items } = await source.fetchBatch({ cursor: null, limit: 10, filters: { products: ['camerasystemen'], services: ['installatie'], provinces: ['Zuid-Holland'], maxQueries: 2, pagesPerCompany: 4 } });
  const stats = source.stats();
  assert.equal(provider.queries.length, 2);
  assert.deepEqual(items.map(i => i.externalId).sort(), ['beveiligingsnieuws.example', 'camerashop.example', 'veilig-zuid.example']);
  assert.deepEqual(stats.excludedResults, { directory: 2, social: 2 });
  assert.deepEqual(stats.sitesFailed.map(f => f.domain), ['kapot.example']);
  assert.ok(!calls.some(url => /bedrijvenpagina|linkedin/.test(url)), 'directories and social media are never fetched');
  assert.ok(items.find(i => i.externalId === 'veilig-zuid.example').raw.pages.some(p => p.url.endsWith('/diensten')), 'the search result page itself is read');
  assert.ok(items.every(i => i.raw.pages.length <= 4));
});

test('route A respects the company budget and says how many candidates were not researched; no provider or no subject is refused', async () => {
  const provider = fakeSearchProvider([['camera', SECURITY_RESULTS]]);
  const { deps: d } = deps(SITES, provider);
  const source = createCompanySearchSource(d);
  const { items } = await source.fetchBatch({ cursor: null, limit: 10, filters: { products: ['camerasystemen'], maxQueries: 1, maxCompanies: 1, pagesPerCompany: 2 } });
  assert.equal(items.length, 1);
  assert.ok(source.stats().candidatesNotResearched >= 2);
  await assert.rejects(createCompanySearchSource(deps(SITES).deps).fetchBatch({ cursor: null, limit: 5, filters: { products: ['camerasystemen'] } }), /geen zoekprovider/);
  await assert.rejects(createCompanySearchSource(d).fetchBatch({ cursor: null, limit: 5, filters: { provinces: ['Zuid-Holland'] } }), /wat voor bedrijven/);
  await assert.rejects(createCompanySearchSource(deps(SITES, fakeSearchProvider([], { fail: true })).deps).fetchBatch({ cursor: null, limit: 5, filters: { products: ['camerasystemen'] } }), /zoekprovider gaf geen resultaten/);
});

test('route B: a direct website; a directory or social URL is refused; an unreachable site is a clear error', async () => {
  const { deps: d } = deps();
  await assert.rejects(createCompanyWebsiteSource(d).fetchBatch({ cursor: null, limit: 1, filters: { url: 'https://www.linkedin.com/company/x' } }), /geen bedrijfswebsite/);
  await assert.rejects(createCompanyWebsiteSource(d).fetchBatch({ cursor: null, limit: 1, filters: { url: 'ftp://x.example' } }), /http/);
  await assert.rejects(createCompanyWebsiteSource(d).fetchBatch({ cursor: null, limit: 1, filters: { url: 'https://kapot.example/' } }), /niet bereikbaar|geblokkeerd/);
});

test('found in the acceptance run: glued page text, a page word after a postcode, and a municipality are handled', async () => {
  const { analyzeCompanyPage, termSpecs, isPublicAuthority } = await import('../dist/index.js');
  const { load } = await import('cheerio');
  const page = html => ({ $: load(html), url: 'https://zorg.example/contact', isHomepage: false, contacts: { email: null, phone: null, whatsapp: null, instagram: null, facebook: null } });
  const glued = analyzeCompanyPage(page('<html><body><p><span>Laan 1</span><span>2511 AB</span><span>Den Haag</span><span>Openingstijden</span></p></body></html>'), termSpecs(null));
  assert.deepEqual(glued.addresses.map(a => [a.city, a.province]), [['Den Haag', 'NL-ZH']]);
  const pageWord = analyzeCompanyPage(page('<html><body><p>3011 AB Openingstijden ma-vr</p><p>1851 AB Heiloo</p></body></html>'), termSpecs(null));
  assert.deepEqual(pageWord.addresses.map(a => a.city), [null, 'Heiloo'], 'an unknown place is kept as written, a page word is not a place');
  assert.equal(isPublicAuthority({ name: 'Gemeente Den Haag', tradeNames: [], domain: 'denhaag.nl' }), true);
  assert.equal(isPublicAuthority({ name: 'Stichting Eykenburg', tradeNames: [], domain: 'eykenburg.nl' }), false);
});

test('found in the manual check: values of one kind are alternatives; short words, cookie banners and "© Copyright -" are handled', async () => {
  const { analyzeCompanyPage, termSpecs } = await import('../dist/index.js');
  const { load } = await import('cheerio');
  const page = html => analyzeCompanyPage({ $: load(html), url: 'https://bouw.example/', isHomepage: true, contacts: { email: null, phone: null, whatsapp: null, instagram: null, facebook: null } }, termSpecs(null));
  const cookie = page('<html><body><div class="cookie-banner">Functionele cookies die zorgen voor een goed werkende website.</div><p>Wij bouwen woningen.</p></body></html>');
  assert.ok(!cookie.hits.some(h => h.key === 'industry:healthcare'), '"zorgen" in a cookie banner is not care');
  assert.ok(!cookie.hits.some(h => h.key === 'industry:construction'), '"bouwen" (a verb) is not the branch "bouw"');
  assert.equal(page('<html><body><p>Welkom</p><footer>© Copyright - Lammersen Bouwbedrijf BV</footer></body></html>').legalNameInFooter, 'Lammersen Bouwbedrijf BV');
  const { facts } = await profileOf('https://www.veilig-zuid.example/');
  const either = evaluateCompany(facts, criteria({ products: ['camerasystemen', 'medische apparatuur'], provinces: ['NL-ZH'] }), CHECKED);
  assert.equal(either.status, 'confirmed', 'one of two alternative products is enough');
  assert.deepEqual(either.matches.filter(m => m.kind === 'product').map(m => m.status), ['confirmed', 'insufficient'], 'each value keeps its own evidence');
  assert.equal(evaluateCompany(facts, criteria({ products: ['camerasystemen'], customerSectors: ['datacenters'] }), CHECKED).status, 'possible', 'different kinds all apply');
});

test('an address read wrongly before is corrected when a later run reads the same postcode as a known place', async () => {
  const { facts } = await profileOf('https://www.veilig-zuid.example/');
  const wrong = { ...facts, locations: [{ ...facts.locations[0], city: 'Openingstijden', province: null }] };
  const update = updateStoredCompany(wrong, { ...facts, lastCheckedAt: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(update.facts.locations.map(l => [l.city, l.province]), [['Rotterdam', 'NL-ZH']]);
  assert.equal(update.changed, true);
});
