import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTenderSearchQueries, parseTenderSearchFilters, rankTenderCandidate, tenderMatchesKeywords, TENDER_INTENTS } from '../dist/index.js';

const rank = (path, label = '', source = 'link') => rankTenderCandidate({ url: `https://gemeente-voorbeeld.example${path}`, source, label, discoveredFrom: 'https://gemeente-voorbeeld.example/' });

test('branch and keywords stay separate fields; both, and the region, end up in every query next to one tender intent', () => {
  const input = parseTenderSearchFilters({ branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'Nederland' });
  assert.deepEqual([input.branch, input.keywords, input.region, input.country], ['Bouw', 'renovatie schoolgebouwen', 'Zuid-Holland', 'NL']);
  const queries = buildTenderSearchQueries(input, { maxQueries: 6 });
  assert.equal(queries.length, 6);
  for (const { query, intent } of queries) {
    assert.ok(query.includes(intent), query);
    assert.match(query, /Bouw renovatie schoolgebouwen Zuid-Holland$/, 'branch, keywords and region as typed, in that order');
  }
});

test('the queries use generic tender intents (Dutch first for the Netherlands, both languages covered) and never a hardcoded branch', () => {
  const input = parseTenderSearchFilters({ branch: 'ICT', keywords: 'security', country: 'NL' });
  const queries = buildTenderSearchQueries(input, { maxQueries: 8 });
  const intents = queries.map(q => q.intent);
  assert.equal(intents[0], 'aanbesteding');
  assert.ok(intents.includes('offerteaanvraag') && intents.includes('tender') && intents.includes('request for proposal RFP'));
  const known = new Set([...TENDER_INTENTS.nl, ...TENDER_INTENTS.en]);
  assert.ok(intents.every(intent => known.has(intent)));
  assert.ok(queries.every(q => !/bouw|schoonmaak|beveiliging/i.test(q.intent)));
  // Without a region and for the Netherlands nothing is appended; another country is named in the query.
  assert.equal(queries[0].query, 'aanbesteding ICT security');
  const be = buildTenderSearchQueries(parseTenderSearchFilters({ branch: 'ICT', country: 'Duitsland' }), { maxQueries: 2 });
  assert.equal(be[0].intent, 'tender', 'English intents first outside the Dutch-speaking countries');
  assert.match(be[0].query, /Duitsland$/);
});

test('the number of queries is bounded and there are no duplicate queries', () => {
  const input = parseTenderSearchFilters({ branch: 'Bouw' });
  assert.equal(buildTenderSearchQueries(input).length, 4);
  assert.equal(buildTenderSearchQueries(input, { maxQueries: 99 }).length, 8, 'as many as there are distinct intents');
  const queries = buildTenderSearchQueries(input, { maxQueries: 10 }).map(q => q.query.toLowerCase());
  assert.equal(new Set(queries).size, queries.length);
});

test('search filters are validated: a branch or keywords is required, the country must be known, CPV prefixes must be digits, the period at most 14 days', () => {
  assert.throws(() => parseTenderSearchFilters({}), /branche of zoektermen/);
  assert.throws(() => parseTenderSearchFilters({ branch: 'Bouw', country: 'Atlantis' }), /Onbekend land/);
  assert.throws(() => parseTenderSearchFilters({ branch: 'Bouw', cpvPrefixes: ['abc'] }), /cpvPrefixes/);
  assert.throws(() => parseTenderSearchFilters({ branch: 'Bouw', publishedFrom: '2026-01-01', publishedTo: '2026-03-01' }), /at most 14 days/);
  const ok = parseTenderSearchFilters({ keywords: '  onderhoud   scholen ', cpvPrefixes: ['45', '72'] });
  assert.equal(ok.keywords, 'onderhoud scholen');
  assert.equal(ok.branch, null);
  assert.deepEqual(ok.cpvPrefixes, ['45', '72']);
});

test('keywords narrow API results by word (prefix match), without keywords everything fits', () => {
  const fits = (title, keywords) => tenderMatchesKeywords({ title, contractingAuthority: 'Gemeente Voorbeeld', description: null }, keywords);
  assert.equal(fits('Onderhoud schoolgebouwen 2026', 'onderhoud scholen'), true);
  assert.equal(fits('Renovatie schoolgebouw', 'schoolgebouwen'), true, 'singular/plural');
  assert.equal(fits('Levering kantoormeubilair', 'onderhoud scholen'), false);
  assert.equal(fits('Levering kantoormeubilair', null), true);
});

test('candidate ranking: tender item pages, overviews, general purchasing pages and paging are told apart by path and link text', () => {
  assert.equal(rank('/aanbestedingen/renovatie-basisschool-de-ster').classification, 'detail');
  assert.equal(rank('/aanbestedingen/12345').classification, 'detail');
  assert.equal(rank('/nieuws/aanbesteding-onderhoud-openbaar-groen').classification, 'detail');
  assert.equal(rank('/aanbestedingen').classification, 'listing');
  assert.equal(rank('/aanbestedingen/page/2').classification, 'pagination');
  assert.equal(rank('/aanbestedingen?pagina=3').classification, 'pagination');
  assert.equal(rank('/inkoop/leveranciers').classification, 'general');
  assert.equal(rank('/contact').classification, 'general');
  assert.ok(rank('/aanbestedingen/renovatie-basisschool-de-ster').score > rank('/aanbestedingen').score, 'a tender page is fetched before its overview');
  assert.ok(rank('/aanbestedingen').score > rank('/over-ons/organisatie').score);
  assert.ok(rank('/contact').score < rank('/over-ons/organisatie').score, 'navigation pages are pushed back');
});

test('candidate ranking has no site-specific rules: the same path on any host ranks the same', () => {
  const a = rankTenderCandidate({ url: 'https://een-bedrijf.example/aanbestedingen/nieuwbouw-kantoor', source: 'link', label: '', discoveredFrom: 'x' });
  const b = rankTenderCandidate({ url: 'https://ziekenhuis.example/aanbestedingen/nieuwbouw-kantoor', source: 'link', label: '', discoveredFrom: 'x' });
  assert.deepEqual(a, b);
});
