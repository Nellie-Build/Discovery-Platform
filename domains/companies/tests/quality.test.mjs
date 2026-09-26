import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { EMPTY_CRITERIA, buildCompanyProfile, createCompanyWebsiteSource, evaluateCompany, interpretDescription, parseCriteria, updateStoredCompany } from '../dist/index.js';
import { SITES, webTransport, fakeClock } from './fake-companies.mjs';

/** Companies quality: business types, stricter evidence (related terms, menu-only mentions) and addresses written place-first. */
const CHECKED = '2026-09-26T10:00:00.000Z';
const criteria = over => ({ ...EMPTY_CRITERIA, industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [], businessTypes: [], provinces: [], places: [], exclusions: [], ...over });
async function profileOf(url) {
  const { transport } = webTransport(SITES);
  const { items } = await createCompanyWebsiteSource({ crawler: createDiscoveryCrawler('legacy'), transport, clock: fakeClock() }).fetchBatch({ cursor: null, limit: 1, filters: { url, pagesPerCompany: 12 } });
  const raw = items[0].raw;
  return buildCompanyProfile(raw.pages, { website: raw.website, via: 'website', query: null, searchProvider: null, searchSnippet: null, mode: 'website', checkedAt: CHECKED });
}
const types = facts => Object.fromEntries(facts.businessTypes.map(entry => [entry.type, entry.strength]));

test('business types: a consumer web shop, a business supplier/distributor and a service provider are told apart', async () => {
  assert.deepEqual(types(await profileOf('https://camerashop.example/')), { consumer_webshop: 'strong' });
  const shop = (await profileOf('https://camerashop.example/')).businessTypes[0];
  assert.ok(shop.signals.includes('winkelwagen') && shop.signals.some(s => /prijzen/.test(s)));
  assert.deepEqual(types(await profileOf('https://secu-groothandel.example/')), { b2b_supplier: 'strong', wholesaler: 'strong' });
  assert.equal(types(await profileOf('https://www.veilig-zuid.example/')).service_provider, 'strong');
});

test('business types are searchable, and web shops are never excluded unless asked for', async () => {
  const shop = await profileOf('https://camerashop.example/');
  const secu = await profileOf('https://secu-groothandel.example/');
  const b2b = criteria({ products: ['camerasystemen'], businessTypes: ['b2b_supplier'] });
  assert.equal(evaluateCompany(shop, b2b, CHECKED).matches.find(m => m.kind === 'business_type').status, 'insufficient');
  assert.equal(evaluateCompany(secu, criteria({ products: ['beveiligingsproducten'], businessTypes: ['b2b_supplier'] }), CHECKED).matches.find(m => m.kind === 'business_type').status, 'confirmed');
  assert.notEqual(evaluateCompany(shop, criteria({ products: ['camerasystemen'] }), CHECKED).status, 'insufficient', 'without a business-type criterion a web shop is a normal result');
  assert.equal(evaluateCompany(shop, criteria({ products: ['camerasystemen'], businessTypes: ['consumer_webshop'] }), CHECKED).matches.find(m => m.kind === 'business_type').status, 'confirmed');
  const r = interpretDescription('zakelijke leveranciers van camerasystemen in Zuid-Holland').criteria;
  assert.deepEqual([r.businessTypes, r.products], [['b2b_supplier'], ['camerasystemen']]);
  assert.deepEqual(interpretDescription('webwinkels die zonnepanelen verkopen').criteria.businessTypes, ['consumer_webshop']);
  assert.deepEqual(parseCriteria({ products: ['x'], businessTypes: ['Zakelijke leverancier', 'consumer_webshop'] }).businessTypes, ['b2b_supplier', 'consumer_webshop']);
  assert.throws(() => parseCriteria({ businessTypes: ['piraat'] }), /Onbekend type bedrijf/);
});

test('stricter evidence: "onderwijshuisvesting" is only a lead for school renovation, never proof', async () => {
  const bouw = await profileOf('https://www.onderwijsbouw.example/');
  const related = bouw.specialisations.find(a => a.conceptId === 'school_renovation');
  assert.deepEqual([related.related, related.strength, related.matchedTerms], [true, 'weak', ['onderwijshuisvesting']]);
  const evaluation = evaluateCompany(bouw, criteria({ industries: ['bouw'], specialisations: ['schoolrenovatie'] }), CHECKED);
  const school = evaluation.matches.find(m => m.kind === 'specialisation');
  assert.equal(school.status, 'possible');
  assert.match(school.note, /verwant begrip.*onderwijshuisvesting.*bewijst “schoolrenovatie” niet/);
  assert.notEqual(evaluation.status, 'confirmed');
  assert.deepEqual(interpretDescription('bouwbedrijven gespecialiseerd in renovatie van scholen').criteria.specialisations, ['schoolrenovatie']);
  assert.deepEqual(interpretDescription('onderwijshuisvesting').criteria.specialisations, [], 'a related term is never read as the concept itself');
});

test('stricter evidence: a menu item alone is weak; a sector only named, never supplied, is not a customer sector', async () => {
  const secu = await profileOf('https://secu-groothandel.example/');
  const fire = secu.specialisations.find(a => a.conceptId === 'fire_detection');
  assert.equal(fire.strength, 'weak', '"Branddetectie" only in the menu');
  assert.equal(evaluateCompany(secu, criteria({ specialisations: ['branddetectie'] }), CHECKED).matches[0].status, 'possible');
  const bouw = await profileOf('https://www.onderwijsbouw.example/');
  assert.ok(bouw.customerSectors.find(a => a.conceptId === 'housing_associations').strength === 'strong', '"werken voor woningcorporaties" is supplying them');
});

test('an address with the place before the postcode, and a page word after it, is read correctly', async () => {
  const bouw = await profileOf('https://www.onderwijsbouw.example/');
  assert.deepEqual(bouw.locations.map(l => [l.city, l.municipality, l.province, l.postcode, l.addressType]), [['Vierpolders', 'Voorne aan Zee', 'NL-ZH', '3237 LA', 'visiting']], 'Vierpolders, as written, is in the municipality of Voorne aan Zee (Zuid-Holland)');
  assert.equal(bouw.name, 'Bouwgroep Maas B.V.');
});

test('a stored profile keeps exact and related evidence apart, and gains business types without losing any', async () => {
  const bouw = await profileOf('https://www.onderwijsbouw.example/');
  const exact = { kind: 'specialisation', conceptId: 'school_renovation', label: 'schoolrenovatie', strength: 'strong', evidence: [{ url: 'https://www.onderwijsbouw.example/scholen', pageType: 'services', quote: 'Renovatie van scholen' }] };
  const legacy = { ...bouw, businessTypes: undefined };
  const update = updateStoredCompany(legacy, { ...bouw, specialisations: [...bouw.specialisations, exact], lastCheckedAt: CHECKED });
  const school = update.facts.specialisations.filter(a => a.conceptId === 'school_renovation');
  assert.deepEqual(school.map(a => [Boolean(a.related), a.strength]).sort(), [[false, 'strong'], [true, 'weak']]);
  assert.ok(Array.isArray(update.facts.businessTypes));
});

test('found in the live check: entities in names are decoded; a stored judgement is re-assessed only on the same pages', async () => {
  const { analyzeCompanyPage, termSpecs } = await import('../dist/index.js');
  const { load } = await import('cheerio');
  const page = analyzeCompanyPage({ $: load('<html><head><meta property="og:site_name" content="Goetheer &amp;amp; Huissoon"></head><body><p>Bouw</p></body></html>'), url: 'https://g-h.example/', isHomepage: true, contacts: {} }, termSpecs(null));
  assert.equal(page.siteName, 'Goetheer & Huissoon');

  const bouw = await profileOf('https://www.onderwijsbouw.example/');
  const quote = url => ({ url, pageType: 'home', quote: 'schoolrenovatie' });
  const activity = (strength, urls) => ({ kind: 'specialisation', conceptId: 'school_renovation', label: 'schoolrenovatie', strength, evidence: urls.map(quote) });
  const stored = { ...bouw, specialisations: [activity('strong', ['https://a.example/'])] };
  const samePages = updateStoredCompany(stored, { ...bouw, specialisations: [activity('weak', ['https://a.example/'])], lastCheckedAt: CHECKED });
  assert.equal(samePages.facts.specialisations[0].strength, 'weak', 'the same page, judged under the current rules, is weak');
  const otherPages = updateStoredCompany(stored, { ...bouw, specialisations: [activity('weak', ['https://b.example/'])], lastCheckedAt: CHECKED });
  assert.equal(otherPages.facts.specialisations[0].strength, 'strong', 'evidence on a page not read again is never discounted');
});
