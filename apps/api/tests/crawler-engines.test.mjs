import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';

/**
 * Website discovery runs the same domain pipeline (extract, plausibility, scoring, dedupe) after
 * whichever crawl engine fetched the pages. These tests run the vacancies adapter end to end
 * against WBO- and SPIE-shaped sites with both engines and require identical outcomes, plus the
 * server-side engine selection (legacy by default, never chosen by a request).
 */
const ENGINES = ['legacy', 'crawlee'];
const HOST = 'https://careers.example';

const page = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) });
const text = (body, type = 'text/plain') => ({ status: 200, headers: { 'content-type': type }, body: Buffer.from(body) });
const paragraph = 'Je werkt aan uiteenlopende opdrachten voor onze klanten en denkt mee over de aanpak van complexe vraagstukken, samen met een enthousiast team van collega\'s.';

function jobPosting(title, company, location) {
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } } });
  return `<html><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head><body><a href="mailto:jobs@careers.example">Solliciteer</a></body></html>`;
}
/** Several other vacancies as teasers (card + heading + metadata icon): a listing, not a vacancy. */
function listing(title, cards) {
  return `<html><head><title>${title}</title></head><body><main>${cards.map(([name, href]) =>
    `<section class="vacancy"><h3>${name}</h3><span aria-label="Locatie">Utrecht</span><a href="${href}">Bekijk vacature</a></section>`).join('')}</main></body></html>`;
}
/** A WBO-shaped detail page: no structured data, own metadata icons ("Dit krijg je"), an external
 * "Meer informatie" link ("Over de functiegroep") and a related-vacancies carousel. */
function wboDetail(title) {
  return `<html><head><title>Vacature: ${title}, Rijkswaterstaat - Werken bij de Overheid</title></head><body>
    <header><nav><a href="/">Home</a></nav></header>
    <main><h1>Werken bij de Overheid</h1>
      <div class="width-100">
        <h2>Dit ga je doen</h2><p>${paragraph}</p>
        <h2>Dit krijg je</h2>
        <ul><li><span aria-label="Salaris">€ 4.132 - € 6.275 (bruto)</span></li><li><span aria-label="Arbeidsovereenkomst">Tijdelijk</span></li><li><span aria-label="Uren per week">32 - 36 uur</span></li></ul>
        <h2>Over de functiegroep Expert</h2><p>${paragraph}</p><a href="https://www.functiegebouwrijksoverheid.nl/functiegroep">Meer informatie</a>
        <h2>Stel gerust je vraag</h2><p>Bel Jan Jansen op 06 12345678 of mail jan.jansen@careers.example.</p>
        <a href="/solliciteren">Solliciteer</a>
      </div>
      <section class="job-relevant"><h2 class="job-relevant__header">Relevante vacatures</h2>
        <div class="swiper swiperRelatedJobs"><a href="/vacatures/other-1"><h3>Andere vacature</h3><span aria-label="Salaris">€ 3.000</span></a><a href="/vacatures/other-2"><h3>Nog een vacature</h3><span aria-label="Salaris">€ 3.500</span></a></div></section>
    </main><footer>Footer</footer></body></html>`;
}
function contactPage() {
  return `<html><head><title>Contact</title></head><body><main><h1>Contact</h1><p>${paragraph}</p><p>Neem contact op met Anna de Vries via 06 98765432 of anna@careers.example.</p></main></body></html>`;
}

function spieSite() {
  return {
    '/robots.txt': text('User-agent: *\nAllow: /'),
    '/sitemap.xml': text('<urlset><url><loc>https://careers.example/vacatures/tender-manager</loc></url></urlset>', 'application/xml'),
    '/': page(listing('Werken bij SPIE', [['Tender Manager', '/vacatures/tender-manager'], ['Projectleider', '/vacatures/projectleider'], ['Monteur', '/vacatures/monteur']])),
    '/vacatures': page(listing('Alle vacatures', [['Tender Manager', '/vacatures/tender-manager'], ['Projectleider', '/vacatures/projectleider'], ['Monteur', '/vacatures/monteur']])),
    '/vacatures/tender-manager': page(jobPosting('Tender Manager', 'SPIE', 'Hengelo')),
    '/vacatures/projectleider': page(jobPosting('Projectleider', 'SPIE', 'Utrecht')),
    '/vacatures/monteur': page(jobPosting('Monteur', 'SPIE', 'Zwolle')),
    '/contact': page(contactPage()),
  };
}
function wboSite() {
  return {
    '/robots.txt': text('User-agent: *\nAllow: /'),
    '/sitemap.xml': text('<urlset></urlset>', 'application/xml'),
    '/': page(listing('Werken bij de Overheid', [['Adviseur waterveiligheid', '/vacatures/adviseur-waterveiligheid-RWS-2026-4910'], ['Data-analist', '/vacatures/data-analist-RWS-2026-6578'], ['Jurist', '/vacatures/jurist-RWS-2026-1111']])),
    '/vacatures': page(listing('Vacatures', [['Adviseur waterveiligheid', '/vacatures/adviseur-waterveiligheid-RWS-2026-4910'], ['Data-analist', '/vacatures/data-analist-RWS-2026-6578'], ['Jurist', '/vacatures/jurist-RWS-2026-1111']])),
    '/vacatures/adviseur-waterveiligheid-RWS-2026-4910': page(wboDetail('Adviseur waterveiligheid')),
    '/vacatures/data-analist-RWS-2026-6578': page(wboDetail('Data-analist')),
    '/vacatures/jurist-RWS-2026-1111': page(wboDetail('Jurist')),
  };
}

function transportFor(pages, log = []) {
  return async url => { const path = new URL(url).pathname; log.push(path); return pages[path] ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('nope') }; };
}
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
function websiteInput(sourceUrl, targetRecords = 50) {
  return { mode: 'website', sourceUrl, existingRecords: [], filters: {},
    runConfig: { targetRecords, searchBreadth: 'standard', maxPages: 30, maxCandidates: 100, maxDurationMs: 240_000, maxEnrichments: 10, onlyNewRecords: true } };
}
async function runSite(engine, pages, sourceUrl, targetRecords) {
  const adapter = createVacanciesAdapter({ transport: transportFor(pages), clock: fakeClock(), crawler: createDiscoveryCrawler(engine) });
  return adapter.runDiscovery(websiteInput(sourceUrl, targetRecords));
}
const titles = outcome => outcome.records.map(record => record.displayName).sort();

for (const engine of ENGINES) {
  test(`[${engine}] SPIE-shaped site: real detail pages become records, the overview and the contact page do not`, async () => {
    const outcome = await runSite(engine, spieSite(), `${HOST}/vacatures`);
    assert.deepEqual(titles(outcome), ['Monteur', 'Projectleider', 'Tender Manager']);
    assert.equal(outcome.stats.crawlerEngine, engine);
    const rejected = outcome.stats.pageDiagnostics.filter(page => !page.accepted).map(page => new URL(page.url).pathname);
    assert.ok(rejected.includes('/vacatures'), 'the overview page is not a record');
    assert.ok(!titles(outcome).includes('Contact'));
  });

  test(`[${engine}] a direct SPIE detail URL is processed first and saved`, async () => {
    const pages = spieSite();
    const log = [];
    const adapter = createVacanciesAdapter({ transport: transportFor(pages, log), clock: fakeClock(), crawler: createDiscoveryCrawler(engine) });
    const outcome = await adapter.runDiscovery(websiteInput(`${HOST}/vacatures/tender-manager`));
    assert.equal(outcome.stats.pageDiagnostics[0].url, `${HOST}/vacatures/tender-manager`);
    assert.equal(outcome.stats.pageDiagnostics[0].accepted, true);
    assert.ok(titles(outcome).includes('Tender Manager'));
  });

  test(`[${engine}] the website run reports the crawler figures next to all existing website stats`, async () => {
    const outcome = await runSite(engine, spieSite(), `${HOST}/vacatures`);
    const stats = outcome.stats;
    for (const key of ['crawlerEngine', 'requestsQueued', 'requestsStarted', 'requestsSucceeded', 'requestsFailed', 'requestsRetried', 'maxConcurrencyUsed', 'queueRemaining', 'durationMs']) {
      assert.ok(key in stats, key);
    }
    for (const key of ['pagesVisited', 'urlsDiscovered', 'candidateUrlsFound', 'candidatesProcessed', 'stopReason', 'targetRecords', 'recordsAccepted', 'pageDiagnostics', 'candidateDiagnostics', 'budgetSource']) {
      assert.ok(key in stats, key);
    }
    assert.equal(stats.recordsAccepted, 3);
    assert.equal(stats.maxConcurrencyUsed <= (engine === 'legacy' ? 1 : 3), true);
  });

  test(`[${engine}] the target stops the crawl and the stop reason says so`, async () => {
    const outcome = await runSite(engine, spieSite(), `${HOST}/vacatures`, 1);
    assert.equal(outcome.stats.stopReason, 'target_reached');
    assert.equal(outcome.records.length, 1);
  });
}

test('both engines produce the same records, page decisions and stop reason for the SPIE-shaped site', async () => {
  const [legacy, crawlee] = await Promise.all(ENGINES.map(engine => runSite(engine, spieSite(), `${HOST}/vacatures`)));
  assert.deepEqual(titles(crawlee), titles(legacy));
  assert.equal(crawlee.stats.pagesVisited, legacy.stats.pagesVisited);
  assert.equal(crawlee.stats.stopReason, legacy.stats.stopReason);
  const decisions = outcome => outcome.stats.pageDiagnostics.map(page => `${new URL(page.url).pathname}:${page.accepted}:${page.rejectionReason}`).sort();
  assert.deepEqual(decisions(crawlee), decisions(legacy));
});

test('both engines make the same decisions for the WBO-shaped site, whatever the extractor decides', async () => {
  const [legacy, crawlee] = await Promise.all(ENGINES.map(engine => runSite(engine, wboSite(), `${HOST}/vacatures`)));
  assert.deepEqual(titles(crawlee), titles(legacy));
  const decisions = outcome => outcome.stats.pageDiagnostics.map(page => `${new URL(page.url).pathname}:${page.accepted}:${page.rejectionReason}`).sort();
  assert.deepEqual(decisions(crawlee), decisions(legacy));
  assert.equal(crawlee.stats.pagesVisited, legacy.stats.pagesVisited);
});

// Known issue, deliberately NOT changed by the crawler work: looksLikeOverviewPage() still rejects
// real WBO detail pages, because two headings of the page's own text ("Dit krijg je" with its
// metadata icons, "Over de functiegroep" with an external "Meer informatie" link) count as
// teaser cards. The diagnosis is in docs; the fix awaits approval. These are the acceptance
// tests that fix must turn green, kept as `todo` so they document the expectation without
// failing the suite.
for (const engine of ENGINES) {
  test(`[${engine}] WBO: a real detail page ("Dit krijg je", external "Meer informatie" link) is accepted, the listing is not`, { todo: 'looksLikeOverviewPage overview false negative — fix not yet approved' }, async () => {
    const outcome = await runSite(engine, wboSite(), `${HOST}/vacatures`);
    assert.deepEqual(titles(outcome), ['Adviseur waterveiligheid', 'Data-analist', 'Jurist']);
    const rejected = outcome.stats.pageDiagnostics.filter(page => !page.accepted).map(page => new URL(page.url).pathname);
    assert.ok(rejected.includes('/vacatures'));
  });
}

test('the engine comes from server configuration only: legacy by default, crawlee only when explicitly set, never from the request', async () => {
  const saved = { engine: process.env.DISCOVERY_CRAWLER_ENGINE, concurrency: process.env.DISCOVERY_CRAWLER_CONCURRENCY };
  try {
    const run = async filters => createVacanciesAdapter({ transport: transportFor(spieSite()), clock: fakeClock() })
      .runDiscovery({ ...websiteInput(`${HOST}/vacatures`), filters });
    delete process.env.DISCOVERY_CRAWLER_ENGINE;
    assert.equal((await run({})).stats.crawlerEngine, 'legacy');
    process.env.DISCOVERY_CRAWLER_ENGINE = 'something-else';
    assert.equal((await run({})).stats.crawlerEngine, 'legacy');
    process.env.DISCOVERY_CRAWLER_ENGINE = 'legacy';
    assert.equal((await run({ crawlerEngine: 'crawlee' })).stats.crawlerEngine, 'legacy', 'a request cannot switch engines');
    process.env.DISCOVERY_CRAWLER_ENGINE = 'crawlee';
    process.env.DISCOVERY_CRAWLER_CONCURRENCY = '3';
    const crawlee = await run({});
    assert.equal(crawlee.stats.crawlerEngine, 'crawlee');
    assert.ok(crawlee.stats.maxConcurrencyUsed <= 3);
    assert.equal(titles(crawlee).length, 3);
  } finally {
    for (const [key, value] of [['DISCOVERY_CRAWLER_ENGINE', saved.engine], ['DISCOVERY_CRAWLER_CONCURRENCY', saved.concurrency]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('branch discovery is untouched by the crawler engine setting', async () => {
  const saved = process.env.DISCOVERY_CRAWLER_ENGINE;
  process.env.DISCOVERY_CRAWLER_ENGINE = 'crawlee';
  try {
    const calls = [];
    const jobBoardProvider = { async findCandidates(query) { calls.push(query); return { candidates: [], meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'empty', candidates: 0, durationMs: 1, error: null }] }; } };
    const outcome = await createVacanciesAdapter({ jobBoardProvider }).runDiscovery({
      mode: 'branch', branch: 'Onderwijs', country: 'Nederland', region: 'Zuid-Holland', keywords: null, existingRecords: [], filters: {},
      runConfig: { targetRecords: 50, searchBreadth: 'standard', maxPages: 25, maxCandidates: 500, maxDurationMs: 180_000, maxEnrichments: 30, onlyNewRecords: true },
    });
    assert.equal(calls[0].query, 'Onderwijs');
    assert.equal(outcome.stats.searchMode, 'branch');
    assert.ok(!('crawlerEngine' in outcome.stats));
  } finally {
    if (saved === undefined) delete process.env.DISCOVERY_CRAWLER_ENGINE; else process.env.DISCOVERY_CRAWLER_ENGINE = saved;
  }
});
