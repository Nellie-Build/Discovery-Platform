import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import {
  EMPTY_CRITERIA, MAX_SEARCH_QUERIES, buildCompanyProfile, buildCompanySearchQueries, createCompanySearchSource, createCompanyWebsiteSource,
  criteriaWarnings, evaluateCompany, explainMatches, interpretDescription, parseCriteria, summarizeCriteria, updateStoredCompany,
} from '../dist/index.js';
import { SITES, webTransport, fakeClock, fakeSearchProvider } from './fake-companies.mjs';

/** Companies 2.0, phase A: AND/OR criteria, business types, what a company does with a product, sector basis, geography, query planning. */
const CHECKED = '2026-09-26T10:00:00.000Z';
const criteria = over => ({ ...EMPTY_CRITERIA, ...over });
async function profileOf(url) {
  const { transport } = webTransport(SITES);
  const { items } = await createCompanyWebsiteSource({ crawler: createDiscoveryCrawler('legacy'), transport, clock: fakeClock() }).fetchBatch({ cursor: null, limit: 1, filters: { url, pagesPerCompany: 12 } });
  const raw = items[0].raw;
  return buildCompanyProfile(raw.pages, { website: raw.website, via: 'website', query: null, searchProvider: null, searchSnippet: null, mode: 'website', checkedAt: CHECKED });
}
const types = facts => Object.fromEntries(facts.businessTypes.map(entry => [entry.type, entry.strength]));

// ─── Criteria ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('OR is the default and is said so; AND must be explicit; a plain "en" is flagged, never silently read as AND', () => {
  const plain = interpretDescription('camerabewaking en toegangscontrole in Zuid-Holland');
  assert.deepEqual(plain.criteria.products, ['camerasystemen', 'toegangscontrolesystemen']);
  assert.equal(plain.criteria.logic.products, undefined, 'OR by default');
  assert.ok(plain.warnings.some(w => /één van beide/.test(w)), 'the reading of "en" is shown so the user can change it');
  for (const text of ['zowel camerabewaking als toegangscontrole', 'camerabewaking én toegangscontrole']) {
    assert.equal(interpretDescription(text).criteria.logic.products, 'all', text);
  }
  assert.match(summarizeCriteria(parseCriteria({ products: ['camerasystemen', 'toegangscontrolesystemen'], logic: { products: 'all' } })), /camerasystemen én toegangscontrolesystemen/);
  assert.match(summarizeCriteria(parseCriteria({ products: ['camerasystemen', 'toegangscontrolesystemen'] })), /camerasystemen of toegangscontrolesystemen/);
  assert.throws(() => parseCriteria({ products: ['camerasystemen'], logic: { products: 'xor' } }), /logica|of|en/i);
  // A saved search without logic keeps meaning what it meant.
  assert.deepEqual(parseCriteria({ products: ['camerasystemen'] }).logic, {});
});

test('complex combinations: via distributors, only business customers, and contradictions are reported', () => {
  const via = interpretDescription('fabrikanten van camerasystemen die verkopen via distributeurs');
  assert.ok(via.criteria.customerSectors.includes('distributeurs'));
  assert.ok(via.criteria.roles.includes('manufacturer') || via.criteria.businessTypes.includes('manufacturer'));
  const b2b = interpretDescription('leveranciers van camerasystemen die uitsluitend aan zakelijke afnemers leveren');
  assert.ok(b2b.criteria.businessTypes.includes('b2b_supplier'));
  assert.deepEqual(b2b.criteria.excludedBusinessTypes, ['consumer_webshop']);
  assert.ok(criteriaWarnings(parseCriteria({ products: ['camerasystemen'], businessTypes: ['consumer_webshop'], excludedBusinessTypes: ['consumer_webshop'] })).length > 0);
  assert.ok(criteriaWarnings(parseCriteria({ products: ['camerasystemen'], provinces: ['NL-ZH'], places: ['Arnhem'] })).some(w => /Arnhem/.test(w)));
  assert.ok(criteriaWarnings(parseCriteria({ products: ['camerasystemen'], exclusions: ['camerasystemen'] })).length > 0);
});

// ─── Business types and what a company does ─────────────────────────────────────────────────────────────────────────

test('business types: installer, manufacturer via dealers and consumer web shop are told apart with evidence', async () => {
  const installer = await profileOf('https://www.veilig-zuid.example/');
  const maker = await profileOf('https://www.camfab.example/');
  const shop = await profileOf('https://camerashop.example/');
  assert.equal(types(installer).installer, 'strong');
  assert.equal(types(maker).manufacturer, 'strong');
  assert.equal(types(maker).installer, undefined, 'a manufacturer is not an installer');
  assert.deepEqual(types(shop), { consumer_webshop: 'strong' }, 'a web shop selling cameras is not a business supplier or installer');
  for (const entry of [...installer.businessTypes, ...maker.businessTypes]) assert.ok(entry.signals.length > 0 && entry.sourceUrl, 'every type has evidence');
  // What the company does with a product, each with its own sentence.
  const cctv = installer.products.find(a => a.conceptId === 'cctv');
  assert.ok(cctv.actions.some(a => a.action === 'installs' && /installeren/.test(a.quote)));
  assert.ok(cctv.actions.some(a => a.action === 'maintains'));
  assert.deepEqual(maker.products.find(a => a.conceptId === 'cctv').actions.map(a => a.action), ['produces']);
  assert.equal(shop.products.find(a => a.conceptId === 'cctv').actions, undefined);
});

test('an excluded business type removes a clear case, and a weak hint is shown as a warning', async () => {
  const shop = await profileOf('https://camerashop.example/');
  const noShops = criteria({ products: ['camerasystemen'], excludedBusinessTypes: ['consumer_webshop'] });
  assert.equal(evaluateCompany(shop, noShops, CHECKED).excludedBy, 'Consumentenwebwinkel');
  assert.equal(evaluateCompany(shop, criteria({ products: ['camerasystemen'] }), CHECKED).excludedBy, null, 'web shops are only excluded when asked');
  const weak = { ...shop, businessTypes: [{ ...shop.businessTypes[0], strength: 'weak' }] };
  const evaluation = evaluateCompany(weak, noShops, CHECKED);
  assert.equal(evaluation.excludedBy, null);
  assert.match(explainMatches(evaluation.matches), /Let op: mogelijk consumentenwebwinkel/);
});

test('AND needs every value confirmed; OR needs one', async () => {
  const installer = await profileOf('https://www.veilig-zuid.example/');
  const shop = await profileOf('https://camerashop.example/');
  const both = { products: ['camerasystemen', 'toegangscontrolesystemen'], provinces: [], places: [] };
  assert.equal(evaluateCompany(installer, criteria({ ...both, logic: { products: 'all' } }), CHECKED).status, 'confirmed');
  assert.notEqual(evaluateCompany(shop, criteria({ ...both, logic: { products: 'all' } }), CHECKED).status, 'confirmed', 'a shop without access control never fully matches AND');
  const or = evaluateCompany(shop, criteria(both), CHECKED);
  assert.ok(['confirmed', 'possible'].includes(or.status));
  assert.ok(or.matches.find(m => m.criterion === 'camerasystemen').status === 'confirmed');
});

// ─── Customer sectors ───────────────────────────────────────────────────────────────────────────────────────────────

test('customer sectors: an offering, a reference project and a passing mention are different evidence', async () => {
  const installer = await profileOf('https://www.veilig-zuid.example/');
  const postbus = await profileOf('https://www.haagse-beveiliging.example/');
  const shop = await profileOf('https://camerashop.example/');
  const maker = await profileOf('https://www.camfab.example/');
  assert.equal(installer.customerSectors.find(a => a.conceptId === 'care_institutions').basis, 'offering');
  assert.equal(postbus.customerSectors.find(a => a.conceptId === 'care_institutions').basis, 'reference');
  const hospital = shop.customerSectors.find(a => a.conceptId === 'hospitals');
  assert.deepEqual([hospital.basis, hospital.strength], ['mention', 'weak']);
  assert.equal(maker.customerSectors.find(a => a.conceptId === 'distributors').basis, 'offering', '"verkopen via ons dealernetwerk" is a sales channel');
  const care = criteria({ customerSectors: ['zorginstellingen'] });
  assert.match(explainMatches(evaluateCompany(postbus, care, CHECKED).matches), /referentieproject bij zorginstellingen/);
  assert.match(evaluateCompany(installer, care, CHECKED).matches[0].note, /Biedt/);
  assert.notEqual(evaluateCompany(shop, criteria({ customerSectors: ['ziekenhuizen'] }), CHECKED).matches[0].status, 'confirmed');
});

// ─── Geography ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('geography: establishment, municipality, postal address and service area are separate', async () => {
  const maker = await profileOf('https://www.camfab.example/');
  const postbus = await profileOf('https://www.haagse-beveiliging.example/');
  assert.deepEqual(maker.locations.map(l => [l.city, l.municipality, l.province, l.addressType]), [['Ede', 'Ede', 'NL-GE', 'visiting']]);
  assert.deepEqual(maker.serviceAreas.map(a => a.scope), ['national']);
  // A Gelderland company serving the whole country: found nationally, only possible for Zuid-Holland.
  assert.equal(evaluateCompany(maker, criteria({ products: ['camerasystemen'] }), CHECKED).matches.find(m => m.kind === 'country').status, 'confirmed');
  assert.equal(evaluateCompany(maker, criteria({ products: ['camerasystemen'], provinces: ['NL-ZH'] }), CHECKED).matches.find(m => m.kind === 'province').status, 'possible');
  // A postal address is not an establishment.
  assert.deepEqual(postbus.locations.map(l => [l.address, l.addressType]), [['Postbus 1234', 'postal']]);
  const zh = evaluateCompany(postbus, criteria({ products: ['camerasystemen'], provinces: ['NL-ZH'] }), CHECKED).matches.find(m => m.kind === 'province');
  assert.equal(zh.status, 'possible');
  assert.match(zh.note, /postadres/);
  assert.deepEqual(postbus.serviceAreas, [], 'neither the postal address nor a project is a service area');
  const explanation = explainMatches(evaluateCompany(postbus, criteria({ products: ['camerasystemen'], provinces: ['NL-ZH'] }), CHECKED).matches);
  assert.match(explanation, /^Bevestigd: levert camerasystemen\. Mogelijk: werkgebied Zuid-Holland\.$/);
  assert.doesNotMatch(explanation, /%|score/i);
});

test('a stored profile gains actions, sector basis and municipality without losing earlier evidence', async () => {
  const installer = await profileOf('https://www.veilig-zuid.example/');
  const old = {
    ...installer,
    products: installer.products.map(({ actions, ...rest }) => rest),
    customerSectors: installer.customerSectors.map(({ basis, ...rest }) => rest),
    locations: installer.locations.map(({ municipality, addressType, ...rest }) => rest),
  };
  const { facts } = updateStoredCompany(old, installer);
  assert.ok(facts.products.find(a => a.conceptId === 'cctv').actions.some(a => a.action === 'installs'));
  assert.equal(facts.customerSectors.find(a => a.conceptId === 'care_institutions').basis, 'offering');
  assert.deepEqual(facts.locations.map(l => [l.municipality, l.addressType]), [['Rotterdam', 'visiting']]);
  // A later run that only sees a mention on a page not read before never downgrades the stored basis.
  const later = { ...installer, customerSectors: [{ ...installer.customerSectors.find(a => a.conceptId === 'care_institutions'), basis: 'mention', strength: 'weak', evidence: [{ url: 'https://www.veilig-zuid.example/nieuws', quote: 'zorg' }] }] };
  assert.equal(updateStoredCompany(facts, later).facts.customerSectors.find(a => a.conceptId === 'care_institutions').basis, 'offering');
});

// ─── Search planning ────────────────────────────────────────────────────────────────────────────────────────────────

test('query planning: Dutch and English variants, roles, types, each OR value, and a hard maximum', () => {
  const or = buildCompanySearchQueries(parseCriteria({ products: ['camerasystemen', 'toegangscontrolesystemen'], businessTypes: ['b2b_supplier', 'installer'], country: 'NL' }), 12);
  const queries = or.map(q => q.query);
  assert.ok(queries.some(q => /toegangscontrole/.test(q) && !/camera/.test(q)), 'the OR alternative is its own query');
  assert.ok(queries.some(q => /^installateur /.test(q)), 'the second business type');
  assert.ok(queries.some(q => /cctv systems/.test(q) && /Netherlands/.test(q)), 'an English variant');
  assert.equal(new Set(queries.map(q => q.toLowerCase())).size, queries.length, 'no duplicate queries');
  const and = buildCompanySearchQueries(parseCriteria({ products: ['camerasystemen', 'toegangscontrolesystemen'], logic: { products: 'all' } }), 12);
  assert.ok(and.every(q => /toegangscontrole|access control/.test(q.query)), 'with AND every query asks for both');
  const many = parseCriteria({ industries: ['beveiliging'], products: ['camerasystemen', 'alarmsystemen', 'toegangscontrolesystemen'], services: ['installatie', 'onderhoud'], customerSectors: ['zorginstellingen'], businessTypes: ['installer', 'wholesaler', 'manufacturer'], provinces: ['NL-ZH'], query: 'bewaking' });
  assert.ok(buildCompanySearchQueries(many, 99).length <= MAX_SEARCH_QUERIES);
});

const RESULTS = [
  ['camerasystemen', [['https://www.veilig-zuid.example/', 'Veilig Zuid', 'camerabewaking'], ['https://www.linkedin.com/company/x', 'LinkedIn', null]]],
  ['camerabewaking', [['https://www.veilig-zuid.example/diensten', 'Veilig Zuid diensten', 'camerabewaking'], ['https://www.camfab.example/', 'CamFab', 'camerasystemen']]],
];

test('route A reports per query: results, new candidates, duplicates and excluded hosts', async () => {
  const { transport } = webTransport(SITES);
  const provider = fakeSearchProvider(RESULTS);
  const source = createCompanySearchSource({ crawler: createDiscoveryCrawler('legacy'), searchProvider: provider, transport, clock: fakeClock() });
  await source.fetchBatch({ cursor: null, limit: 10, filters: { products: ['camerasystemen'], maxQueries: 2, maxCompanies: 2, pagesPerCompany: 2 } });
  const [first, second] = source.stats().queries;
  assert.deepEqual([first.results, first.newCandidates, first.duplicates, first.excluded], [2, 1, 0, 1]);
  assert.deepEqual([second.results, second.newCandidates, second.duplicates, second.excluded], [2, 1, 1, 0], 'the same official domain is deduplicated early');
  assert.equal(source.stats().companyCandidates, 2);
});

test('route A: a failing provider keeps what earlier queries found and lists the queries not executed', async () => {
  const { transport } = webTransport(SITES);
  let calls = 0;
  const provider = {
    async search(input) {
      calls++;
      if (calls === 1) return [{ url: 'https://www.veilig-zuid.example/', title: 'Veilig Zuid', snippet: 'camerabewaking', source: 'fake' }];
      throw new Error('429 rate limited');
    },
  };
  const source = createCompanySearchSource({ crawler: createDiscoveryCrawler('legacy'), searchProvider: provider, transport, clock: fakeClock() });
  const { items } = await source.fetchBatch({ cursor: null, limit: 10, filters: { products: ['camerasystemen'], services: ['installatie'], customerSectors: ['zorginstellingen'], maxQueries: 6, maxCompanies: 1, pagesPerCompany: 2 } });
  assert.equal(items.length, 1, 'the candidate found before the failure is still researched');
  assert.equal(calls, 3, 'after two failures in a row no more credits are spent');
  const stats = source.stats();
  assert.equal(stats.queries.filter(q => q.error).length, 2);
  assert.ok(stats.queriesNotExecuted.length >= 1 && stats.queriesNotExecuted.every(q => q.reason === 'zoekprovider niet beschikbaar'));
});

test('route A stops searching when enough candidates were found and three queries in a row found nothing new', async () => {
  const { transport } = webTransport(SITES);
  const provider = fakeSearchProvider([['', [['https://www.veilig-zuid.example/', 'Veilig Zuid', 'camerabewaking']]]]);
  const source = createCompanySearchSource({ crawler: createDiscoveryCrawler('legacy'), searchProvider: provider, transport, clock: fakeClock() });
  await source.fetchBatch({ cursor: null, limit: 10, filters: { products: ['camerasystemen'], services: ['installatie'], customerSectors: ['zorginstellingen'], provinces: ['Zuid-Holland'], maxQueries: 8, maxCompanies: 1, pagesPerCompany: 2 } });
  assert.equal(provider.queries.length, 4, 'one query with the candidate, then three without anything new');
  assert.ok(source.stats().queriesNotExecuted.every(q => q.reason === 'geen nieuwe kandidaten meer'));
});

// ─── CSV export ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('CSV export: every cell quoted, formulas neutralised, no personal data, explanation per company', async () => {
  const { companiesCsv, csvCell } = await import('../dist/index.js');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  for (const start of ['=', '+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${start}1`).startsWith(`"'`), JSON.stringify(start));
  assert.equal(csvCell('regel 1\nregel 2'), '"regel 1 regel 2"');
  assert.equal(csvCell(null), '""');
  const installer = await profileOf('https://www.veilig-zuid.example/');
  const evaluated = { ...installer, name: '=cmd|calc', search: { criteria: 'Product: camerasystemen', status: 'confirmed', checkedAt: CHECKED, matches: evaluateCompany(installer, criteria({ products: ['camerasystemen'], provinces: ['NL-ZH'] }), CHECKED).matches } };
  const csv = companiesCsv([evaluated]);
  assert.ok(csv.startsWith('﻿"Naam";"Website"'));
  const [header, row] = csv.slice(1).trim().split('\r\n');
  assert.equal(header.split(';').length, row.split(';').length);
  assert.match(row, /^"'=cmd\|calc"/, 'a company name cannot run as a formula');
  assert.match(row, /Volledig onderbouwd/);
  assert.match(row, /Bevestigd: levert camerasystemen\. Bevestigd: werkgebied Zuid-Holland\./);
  assert.match(row, /zorginstellingen \(aanbod\)/);
  assert.doesNotMatch(csv, /@veilig-zuid|0101234567|06 12345678|jan\.jansen/, 'no e-mail addresses or phone numbers');
  assert.match(row, /12345678/, 'the stated KvK number, labelled as not verified in the header');
  assert.match(header, /niet geverifieerd/);
});
