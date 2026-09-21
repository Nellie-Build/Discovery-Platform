import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';

/**
 * One vacancy published under many addresses (a language segment in front of the same explicit job ID):
 * the run must crawl it once, count it once towards the target, and never store it again in a later run —
 * also when no company could be extracted. Runs the whole vacancies adapter on both crawl engines.
 */
const LANGS = ['nl', 'en', 'de', 'fr', 'se', 'no', 'dk', 'fi', 'pl', 'cn', 'ro', 'ny'];
const HOST = 'https://jobs.example';
const jobPath = (lang, id) => `/${lang}/what:job/jobID:${id}/`;
const page = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) });
const text = (body, type = 'text/plain') => ({ status: 200, headers: { 'content-type': type }, body: Buffer.from(body) });
/** A vacancy page without any employer: title, location and a description only. */
function vacancyPage(id, lang, title = `Medewerker ${id}`) {
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    description: `<p>Vacature ${id}: je werkt in een team aan uiteenlopende opdrachten, denkt mee over de aanpak en draagt bij aan goede resultaten voor onze inwoners.</p>`,
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Katwijk' } } });
  return page(`<html lang="${lang}"><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head><body><main><h1>${title}</h1></main></body></html>`);
}
function site(ids) {
  const pages = { '/robots.txt': text('User-agent: *\nAllow: /'), '/sitemap.xml': text('<urlset></urlset>', 'application/xml') };
  const links = [];
  for (const id of ids) for (const lang of LANGS) { links.push(`<a href="${jobPath(lang, id)}">Medewerker ${id}</a>`); pages[jobPath(lang, id)] = vacancyPage(id, lang); }
  pages['/'] = page(`<html><head><title>Start</title></head><body>${links.join('')}</body></html>`);
  return pages;
}
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
function input(targetRecords, existingRecords = []) {
  return { mode: 'website', sourceUrl: `${HOST}/`, existingRecords, filters: {},
    runConfig: { targetRecords, searchBreadth: 'standard', maxPages: 200, maxCandidates: 500, maxDurationMs: 240_000, maxEnrichments: 10, onlyNewRecords: true } };
}
async function run(engine, pages, runInput) {
  const log = [];
  const transport = async url => { const path = new URL(url).pathname; log.push(path); return pages[path] ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('nope') }; };
  const adapter = createVacanciesAdapter({ transport, clock: fakeClock(), crawler: createDiscoveryCrawler(engine) });
  const outcome = await adapter.runDiscovery(runInput);
  return { outcome, log };
}
const idOf = path => /jobID:(\d+)/.exec(path)?.[1];

for (const engine of ['legacy', 'crawlee']) {
  test(`[${engine}] target 25 with 8 vacancies x 12 language variants: 8 records, not 25, and no target_reached`, async () => {
    const ids = Array.from({ length: 8 }, (_, i) => 966000 + i);
    const { outcome, log } = await run(engine, site(ids), input(25));
    assert.equal(outcome.records.length, 8);
    assert.deepEqual(outcome.records.map(record => idOf(record.domainData.sourceUrl)).sort(), ids.map(String));
    assert.ok(outcome.records.every(record => record.domainData.company === null), 'these vacancies have no company');
    assert.notEqual(outcome.stats.stopReason, 'target_reached');
    assert.equal(outcome.stats.stopReason, 'no_more_candidates');
    const perId = new Map();
    for (const path of log) { const id = idOf(path); if (id) perId.set(id, (perId.get(id) ?? 0) + 1); }
    assert.ok([...perId.values()].every(count => count === 1), 'every job page is fetched once');
    // 96 job URLs (plus the start page) are published, 8 job identities are crawled; discovery shows both numbers.
    assert.equal(outcome.stats.uniqueCrawlIdentities, 8 + 1);
    assert.equal(outcome.stats.uniqueUrlsDiscovered, 96 + 1);
    assert.equal(outcome.stats.candidateIdentityDuplicates, 88);
    assert.equal(outcome.stats.recordsAccepted, 8);
    assert.equal(outcome.stats.duplicatesWithinCrawl, 0, 'the variants never had to be collapsed afterwards');
  });

  test(`[${engine}] cross-run: a record stored via /en/ is not created again when the crawl finds /de/, even without a company`, async () => {
    const existing = [{ id: 'rec-1', domainData: { title: 'Medewerker 966001', company: null, location: 'Katwijk', salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null, sourceUrl: `${HOST}${jobPath('en', 966001)}` } }];
    const pages = site([966001, 966002]);
    // Only the /de/ variant of the known job exists in this crawl.
    for (const lang of LANGS) if (lang !== 'de') delete pages[jobPath(lang, 966001)];
    pages['/'] = page(`<html><head><title>Start</title></head><body><a href="${jobPath('de', 966001)}">a</a><a href="${jobPath('nl', 966002)}">b</a></body></html>`);
    const { outcome } = await run(engine, pages, input(25, existing));
    assert.deepEqual(outcome.records.map(record => idOf(record.domainData.sourceUrl)), ['966002'], 'only the new vacancy is created');
    assert.equal(outcome.stats.duplicatesAgainstExisting, 1);
    assert.equal(outcome.stats.recordsAccepted, 1);
  });
}

test('record-level dedupe still catches variants that were fetched before the identity was known (no candidate-level help)', async () => {
  // Both variants are requested/linked with a different origin spelling only for the crawl; the collapse
  // works on the stored facts, so it must not depend on the crawler having skipped anything.
  const facts = ['en', 'de'].map(lang => ({ title: 'Medewerker 966001', company: null, location: 'Katwijk', salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null, sourceUrl: `${HOST}${jobPath(lang, 966001)}` }));
  const { findVacancyDuplicates } = await import('@discovery-platform/domain-vacancies');
  const [duplicate] = findVacancyDuplicates(facts);
  assert.equal(duplicate.decision, 'duplicate');
  assert.ok(duplicate.matchedSignals.includes('stableJobIdentity'));
});

// ─── cross-run with namespaces: the same number in another record family is another vacancy ─────────

const known = sourceUrl => ({ id: 'rec-1', domainData: { title: 'Wmo consulent', company: null, location: 'Katwijk', salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null, sourceUrl } });
const spontaneousPath = (lang, id) => `/${lang}/what:spontaneous/jobID:${id}/type:spontaneous/where:4/apply:1/`;
function singlePageSite(path, title) {
  return { '/robots.txt': text('User-agent: *\nAllow: /'), '/sitemap.xml': text('<urlset></urlset>', 'application/xml'),
    '/': page(`<html><head><title>Start</title></head><body><a href="${path}">x</a></body></html>`), [path]: vacancyPage(4041, 'de', title) };
}

for (const engine of ['legacy', 'crawlee']) {
  test(`[${engine}] namespace cross-run A: existing /en/what:job/jobID:4041/ vs new /de/what:job/jobID:4041/ is already known`, async () => {
    const { outcome } = await run(engine, singlePageSite(jobPath('de', 4041), 'Wmo consulent (DE)'), input(25, [known(`${HOST}${jobPath('en', 4041)}`)]));
    assert.equal(outcome.records.length, 0);
    assert.equal(outcome.stats.duplicatesAgainstExisting, 1);
  });

  test(`[${engine}] namespace cross-run B: existing what:job 4041 vs new what:spontaneous 4041 is not a duplicate`, async () => {
    const { outcome } = await run(engine, singlePageSite(spontaneousPath('en', 4041), 'Open sollicitatie'), input(25, [known(`${HOST}${jobPath('en', 4041)}`)]));
    assert.equal(outcome.stats.duplicatesAgainstExisting, 0);
    assert.equal(outcome.records.length, 1);
    assert.equal(outcome.records[0].existingRecordId, undefined);
  });

  test(`[${engine}] namespace cross-run C: existing spontaneous 4041 (en) vs new spontaneous 4041 (de) is a duplicate`, async () => {
    const { outcome } = await run(engine, singlePageSite(spontaneousPath('de', 4041), 'Open sollicitatie (DE)'), input(25, [known(`${HOST}${spontaneousPath('en', 4041)}`)]));
    assert.equal(outcome.records.length, 0);
    assert.equal(outcome.stats.duplicatesAgainstExisting, 1);
  });

  test(`[${engine}] namespace cross-run D: the same job ID on another origin is not a duplicate`, async () => {
    const { outcome } = await run(engine, singlePageSite(jobPath('en', 4041), 'Wmo consulent'), input(25, [known(`https://other.example${jobPath('en', 4041)}`)]));
    assert.equal(outcome.stats.duplicatesAgainstExisting, 0);
    assert.equal(outcome.records.length, 1);
  });
}
