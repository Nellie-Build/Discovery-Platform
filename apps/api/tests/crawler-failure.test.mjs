import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '@discovery-platform/core';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';
import { startTestApp, html } from './helpers/test-app.mjs';

/**
 * A crawl whose engine failed before it could fetch anything must never look like a website that
 * "simply had no candidates" (succeeded / no_more_candidates). The failure and the exact place it
 * happened stay in the run statistics.
 */
const real = await import('@crawlee/basic');
const PAGES = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
  '/': { body: html([['/about', 'About']]) },
  '/about': { body: html([]) },
};
const transport = async url => {
  const page = PAGES[new URL(url).pathname];
  return page ? { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body ?? html([])) }
    : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('nope') };
};
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
const failingQueue = { ...real.RequestQueue, open: async () => { throw new Error('queue boom at https://storage.example/q?token=SECRET'); } };
const crawlerFailingAt = () => createDiscoveryCrawler('crawlee', { loadCrawlee: async () => ({ ...real, RequestQueue: failingQueue }) });
const websiteInput = () => ({ mode: 'website', sourceUrl: 'https://careers.example/', existingRecords: [], filters: {},
  runConfig: { targetRecords: 50, searchBreadth: 'standard', maxPages: 30, maxCandidates: 100, maxDurationMs: 240_000, maxEnrichments: 10, onlyNewRecords: true } });

test('an engine failure before the first request is a failed run with the exact phase and error in the statistics', async () => {
  const errors = [];
  const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  let outcome;
  try { outcome = await createVacanciesAdapter({ transport, clock: fakeClock(), crawler: crawlerFailingAt() }).runDiscovery(websiteInput()); }
  finally { console.error = original; }
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Crawler \(crawlee, fase queue_open\) kon geen enkele pagina ophalen: queue boom/);
  assert.ok(!outcome.error.includes('SECRET'));
  const stats = outcome.stats;
  assert.equal(stats.stopReason, 'crawler_failed', 'not "no_more_candidates"');
  assert.equal(stats.crawlStatus, 'failed');
  assert.equal(stats.pagesVisited, 0);
  assert.equal(stats.crawlerEngine, 'crawlee');
  assert.equal(stats.crawlerFailurePhase, 'queue_open');
  assert.equal(stats.crawlerErrorName, 'Error');
  assert.match(stats.crawlerErrorMessage, /queue boom at https:\/\/storage\.example\/q\?…/);
  assert.ok(!JSON.stringify(stats).includes('SECRET'), 'query strings never reach the statistics');
  assert.ok(Array.isArray(stats.crawlerPhases) && stats.crawlerPhases.length >= 3);
  assert.equal(typeof stats.crawlerRuntime.nodeVersion, 'string');
  assert.equal(stats.crawlerRequestHandlerCalls, 0);
  assert.equal(errors.length, 1);
  assert.equal(JSON.parse(errors[0]).event, 'crawlee_run_failed');
});

test('a run that finishes without ever calling the request handler is a failed run, not an empty website', async () => {
  class RunDoesNothing extends real.BasicCrawler { async run() { return {}; } }
  const crawler = createDiscoveryCrawler('crawlee', { loadCrawlee: async () => ({ ...real, BasicCrawler: RunDoesNothing }) });
  const original = console.error; console.error = () => {};
  let outcome;
  try { outcome = await createVacanciesAdapter({ transport, clock: fakeClock(), crawler }).runDiscovery(websiteInput()); }
  finally { console.error = original; }
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.stats.stopReason, 'crawler_failed');
  assert.equal(outcome.stats.crawlerFailurePhase, 'run_no_requests');
  assert.equal(outcome.stats.requestsStarted, 0);
});

test('through the API the run is stored as failed, with the reason on the run and the diagnostics in its stats', async () => {
  const original = console.error; console.error = () => {};
  const app = await startTestApp({ pages: PAGES, apiKey: 'test-key', crawler: crawlerFailingAt() });
  try {
    const workspace = (await app.request('POST', '/workspaces', { body: { name: 'Failure' } })).body;
    const project = (await app.request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Website', domain: 'vacancies' } })).body;
    const run = (await app.request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-careers.example/' } })).body;
    assert.equal(run.status, 'failed');
    assert.match(run.error, /fase queue_open/);
    assert.equal(run.stats.crawlerFailurePhase, 'queue_open');
    assert.equal(run.stats.stopReason, 'crawler_failed');
    const stored = (await app.request('GET', `/runs/${run.id}`)).body;
    assert.equal(stored.status, 'failed');
    assert.equal(stored.stats.crawlerErrorMessage.startsWith('queue boom'), true);
    assert.equal(run.recordsCreated, 0);
  } finally { console.error = original; await app.close(); }
});

test('an engine failure after some pages is a partial run that keeps its records and the failure', async () => {
  const stub = {
    engine: 'crawlee',
    async fetchPage() { throw new Error('unused'); },
    async crawl() {
      return { homepage: 'https://careers.example/', domain: 'careers.example', pagesVisited: 3, httpStatus: 200, candidates: [],
        discoveryStats: { urlsDiscovered: 3, uniqueUrlsDiscovered: 3, sitemapUrlsFound: 0, sitemapCandidatesAccepted: 0, sitemapCandidatesRejected: 0, listingUrlsFound: 0, candidateUrlsFound: 3,
          highConfidenceCandidates: 0, mediumConfidenceCandidates: 0, lowConfidenceCandidates: 3, candidatesProcessed: 3, candidatesRemaining: 0, knownCandidates: 0, newCandidates: 3, unchangedCandidates: 0 },
        status: 'partial', error: 'boom', records: [], contacts: { phones: [], emails: [], whatsapp: [], contactPersons: [] }, extractedPages: [], stopReason: 'no_more_candidates',
        candidatesDiscovered: 3, candidateLimitReached: false,
        crawlerStats: { crawlerEngine: 'crawlee', requestsQueued: 3, requestsStarted: 4, requestsSucceeded: 4, requestsFailed: 0, requestsRetried: 0, maxConcurrencyUsed: 2, queueRemaining: 0, durationMs: 10 },
        crawlerDiagnostics: { crawlerPhase: 'run_completed', crawlerPhases: [], crawlerRequestHandlerCalls: 3, crawlerFailurePhase: 'request_feed', crawlerErrorName: 'Error', crawlerErrorMessage: 'feed boom' } };
    },
  };
  const outcome = await createVacanciesAdapter({ crawler: stub }).runDiscovery(websiteInput());
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.stats.crawlerFailurePhase, 'request_feed');
  assert.equal(outcome.stats.stopReason, 'no_more_candidates');
});

test('runs that reach their pages are untouched: a normal crawl and an ordinary empty website stay succeeded, for both engines', async () => {
  for (const engine of ['legacy', 'crawlee']) {
    const outcome = await createVacanciesAdapter({ transport, clock: fakeClock(), crawler: createDiscoveryCrawler(engine) }).runDiscovery(websiteInput());
    assert.equal(outcome.status, undefined, engine);
    assert.equal(outcome.error, undefined, engine);
    assert.equal(outcome.stats.stopReason, 'no_more_candidates', engine);
    assert.equal(outcome.stats.crawlStatus, 'succeeded', engine);
    assert.ok(outcome.stats.pagesVisited >= 2, engine);
    assert.equal(outcome.stats.crawlerFailurePhase, undefined, engine);
  }
});

test('a site whose robots.txt cannot be read keeps its previous status with the legacy engine: blocked, not an infrastructure failure', async () => {
  const unreachable = async () => { throw new Error('getaddrinfo ENOTFOUND careers.example'); };
  const outcome = await createVacanciesAdapter({ transport: unreachable, clock: fakeClock(), crawler: createDiscoveryCrawler('legacy') }).runDiscovery(websiteInput());
  assert.equal(outcome.stats.crawlStatus, 'blocked');
  assert.equal(outcome.status, undefined);
  assert.equal(outcome.stats.stopReason, 'robots_blocked');
  assert.match(outcome.stats.crawlError, /robots/);
});
