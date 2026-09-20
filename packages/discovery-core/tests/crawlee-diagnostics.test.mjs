import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '../dist/crawler/discovery-crawler.js';
import { describeError, stripUrlQueries, collectRuntimeSnapshot } from '../dist/crawler/crawler-diagnostics.js';

/**
 * When the Crawlee engine cannot do its job in some environment, the run must say where and why:
 * which start-up step failed, the sanitised error, and how far it got. Failures are injected
 * through the engine's `loadCrawlee` seam (the real Crawlee module with one part replaced).
 */
const real = await import('@crawlee/basic');

const ROBOTS = { ct: 'text/plain', b: 'User-agent: *\nAllow: /' };
const PAGES = {
  '/robots.txt': ROBOTS,
  '/sitemap.xml': { ct: 'application/xml', b: '<urlset></urlset>' },
  '/': { ct: 'text/html', b: '<html><title>Home</title><a href="/a">a</a></html>' },
  '/a': { ct: 'text/html', b: '<html><title>A</title></html>' },
};
const transport = async url => {
  const page = PAGES[new URL(url).pathname];
  return page ? { status: 200, headers: { 'content-type': page.ct }, body: Buffer.from(page.b) } : { status: 404, headers: {}, body: Buffer.from('') };
};
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
const contactNormalizers = { normalizePhone: value => value, normalizeEmail: value => value };
const options = (extra = {}) => ({ transport, clock: fakeClock(), contactNormalizers, extract: page => ({ title: page.$('title').text() }), ...extra });

/** Runs a crawl while capturing what is written to the server log. */
async function crawlCapturing(loadCrawlee, extra = {}) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const result = await createDiscoveryCrawler('crawlee', { loadCrawlee }).crawl('https://example.com/', options(extra));
    return { result, logged };
  } finally { console.error = original; }
}
const withPart = (part, value) => async () => ({ ...real, [part]: value });

test('a successful crawl records the start-up phases in order, the queue and runtime snapshots, and no failure', async () => {
  const { result, logged } = await crawlCapturing(async () => real);
  const diagnostics = result.crawlerDiagnostics;
  assert.deepEqual(diagnostics.crawlerPhases.map(item => item.phase), [
    'session_created', 'import_start', 'import_ok', 'configuration_created', 'queue_opened', 'crawler_created', 'run_started', 'request_handler_started', 'run_completed']);
  assert.ok(diagnostics.crawlerPhases.every((item, index, all) => index === 0 || item.ms >= all[index - 1].ms));
  assert.equal(diagnostics.crawlerPhase, 'run_completed');
  assert.ok(diagnostics.crawlerRequestHandlerCalls >= 1);
  assert.equal(diagnostics.crawlerFailurePhase, undefined);
  assert.equal(diagnostics.crawlerErrorMessage, undefined);
  assert.deepEqual({ ...diagnostics.crawlerQueue, totalBefore: undefined, pendingBefore: undefined, handledBefore: undefined, totalAfter: undefined, pendingAfter: undefined, handledAfter: undefined },
    { seedUrlPresent: true, seedUniqueKeyPresent: true, queueOpened: true, totalBefore: undefined, pendingBefore: undefined, handledBefore: undefined, totalAfter: undefined, pendingAfter: undefined, handledAfter: undefined });
  assert.equal(typeof diagnostics.crawlerQueue.pendingBefore, 'number');
  assert.equal(diagnostics.crawlerBasicCrawler.autoscaledPoolCreated, false, 'the pool is created by run()');
  assert.equal(diagnostics.crawlerBasicCrawler.autoscaledPoolCreatedAfterRun, true);
  const runtime = diagnostics.crawlerRuntime;
  assert.equal(runtime.nodeVersion, process.version);
  assert.equal(typeof runtime.procReadable, 'boolean');
  assert.equal(typeof runtime.cgroupReadable, 'boolean');
  assert.equal(typeof runtime.tmpWritable, 'boolean');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(logged, [], 'nothing is logged for a healthy crawl');
});

test('the legacy engine reports no Crawlee diagnostics', async () => {
  const result = await createDiscoveryCrawler('legacy').crawl('https://example.com/', options());
  assert.equal(result.crawlerDiagnostics, undefined);
  assert.equal(result.crawlerStats.crawlerEngine, 'legacy');
});

test('the dynamic import failing is reported as phase "import", with the error, instead of rejecting the run', async () => {
  const { result, logged } = await crawlCapturing(async () => { throw Object.assign(new Error("Cannot find module '@crawlee/basic'"), { code: 'ERR_MODULE_NOT_FOUND' }); });
  const diagnostics = result.crawlerDiagnostics;
  assert.equal(diagnostics.crawlerFailurePhase, 'import');
  assert.equal(diagnostics.crawlerErrorName, 'Error');
  assert.match(diagnostics.crawlerErrorMessage, /Cannot find module/);
  assert.equal(diagnostics.crawlerErrorCode, 'ERR_MODULE_NOT_FOUND');
  assert.equal(diagnostics.crawlerPhase, 'run_failed');
  assert.ok(diagnostics.crawlerPhases.some(item => item.phase === 'import_start'));
  assert.ok(!diagnostics.crawlerPhases.some(item => item.phase === 'import_ok'));
  assert.equal(diagnostics.crawlerRequestHandlerCalls, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.pagesVisited, 0);
  assert.match(result.error, /Cannot find module/);
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { event: 'crawlee_run_failed', phase: 'import', errorName: 'Error', errorMessage: "Cannot find module '@crawlee/basic'", errorCode: 'ERR_MODULE_NOT_FOUND' });
});

test('RequestQueue.open failing is reported as phase "queue_open"', async () => {
  const failingQueue = { ...real.RequestQueue, open: async () => { throw new Error('queue boom'); } };
  const { result } = await crawlCapturing(withPart('RequestQueue', failingQueue));
  const diagnostics = result.crawlerDiagnostics;
  assert.equal(diagnostics.crawlerFailurePhase, 'queue_open');
  assert.equal(diagnostics.crawlerErrorMessage, 'queue boom');
  assert.ok(diagnostics.crawlerPhases.some(item => item.phase === 'configuration_created'));
  assert.ok(!diagnostics.crawlerPhases.some(item => item.phase === 'queue_opened'));
  assert.equal(result.status, 'failed');
  assert.equal(result.pagesVisited, 0);
});

test('the Configuration constructor failing is reported as phase "configuration"', async () => {
  class BrokenConfiguration { constructor() { throw new Error('configuration boom'); } }
  const { result } = await crawlCapturing(withPart('Configuration', BrokenConfiguration));
  assert.equal(result.crawlerDiagnostics.crawlerFailurePhase, 'configuration');
  assert.equal(result.crawlerDiagnostics.crawlerErrorMessage, 'configuration boom');
});

test('the BasicCrawler constructor failing is reported as phase "crawler_create"', async () => {
  class BrokenCrawler { constructor() { throw new TypeError('constructor boom'); } }
  const { result } = await crawlCapturing(withPart('BasicCrawler', BrokenCrawler));
  assert.equal(result.crawlerDiagnostics.crawlerFailurePhase, 'crawler_create');
  assert.equal(result.crawlerDiagnostics.crawlerErrorName, 'TypeError');
});

test('crawler.run() failing before the request handler is reported as phase "run"', async () => {
  class RunFails extends real.BasicCrawler { async run() { throw new Error('run boom'); } }
  const { result } = await crawlCapturing(withPart('BasicCrawler', RunFails));
  const diagnostics = result.crawlerDiagnostics;
  assert.equal(diagnostics.crawlerFailurePhase, 'run');
  assert.equal(diagnostics.crawlerErrorMessage, 'run boom');
  assert.equal(diagnostics.crawlerRequestHandlerCalls, 0);
  assert.ok(diagnostics.crawlerPhases.some(item => item.phase === 'run_started'));
  assert.equal(diagnostics.crawlerQueue.seedUrlPresent, true, 'queue diagnostics were captured right before the run');
  assert.equal(typeof diagnostics.crawlerBasicCrawler.autoscaledPoolCreated, 'boolean');
  assert.equal(result.status, 'failed');
});

test('crawler.run() finishing without ever calling the request handler is reported as "run_no_requests", not as an empty site', async () => {
  class RunDoesNothing extends real.BasicCrawler { async run() { return {}; } }
  const { result } = await crawlCapturing(withPart('BasicCrawler', RunDoesNothing));
  const diagnostics = result.crawlerDiagnostics;
  assert.equal(diagnostics.crawlerFailurePhase, 'run_no_requests');
  assert.equal(diagnostics.crawlerErrorName, 'CrawleeNoRequestsProcessed');
  assert.equal(diagnostics.crawlerRequestHandlerCalls, 0);
  assert.ok(diagnostics.crawlerPhases.some(item => item.phase === 'run_completed'));
  assert.equal(result.status, 'failed');
  assert.equal(result.pagesVisited, 0);
});

test('the request handler itself failing is reported as phase "request_handler", with the pages reached before it', async () => {
  let calls = 0;
  const { result } = await crawlCapturing(async () => real, { extract: page => { calls++; if (calls === 2) throw new RangeError('extractor exploded'); return { title: page.$('title').text() }; } });
  const diagnostics = result.crawlerDiagnostics;
  assert.equal(diagnostics.crawlerFailurePhase, 'request_handler');
  assert.equal(diagnostics.crawlerErrorName, 'RangeError');
  assert.equal(diagnostics.crawlerErrorMessage, 'extractor exploded');
  assert.ok(diagnostics.crawlerRequestHandlerCalls >= 2);
  assert.ok(result.pagesVisited >= 2, 'the first page had been fetched');
  assert.equal(result.extractedPages.length, 1);
});

test('the error is sanitised: query strings removed, message/cause/stack bounded, no environment values', async () => {
  process.env.DIAG_TEST_SECRET = 'super-secret-value-123';
  try {
    const cause = new Error('inner failure at https://internal.example/path?apikey=SECRET-CAUSE');
    const error = new Error(`fetch failed for https://api.example.com/v1/items?token=SECRET-TOKEN&x=1 ${'x'.repeat(3000)}`, { cause });
    error.code = 'ECONNRESET';
    const described = describeError(error);
    assert.equal(described.crawlerErrorName, 'Error');
    assert.ok(described.crawlerErrorMessage.length <= 1000);
    assert.ok(described.crawlerErrorMessage.startsWith('fetch failed for https://api.example.com/v1/items?…'));
    assert.equal(described.crawlerErrorCode, 'ECONNRESET');
    assert.ok(described.crawlerErrorCause.startsWith('Error: inner failure at https://internal.example/path?…'));
    assert.ok(described.crawlerErrorStack.split('\n').length <= 8);
    assert.ok(described.crawlerErrorStack.length <= 2000);
    const serialized = JSON.stringify(described);
    for (const forbidden of ['SECRET-TOKEN', 'SECRET-CAUSE', 'super-secret-value-123']) assert.ok(!serialized.includes(forbidden), forbidden);
    assert.equal(stripUrlQueries('see https://a.example/x?y=1#frag and http://b.example/'), 'see https://a.example/x?… and http://b.example/');
    assert.equal(describeError('plain string').crawlerErrorName, 'string');
    assert.equal(describeError({ weird: true }).crawlerErrorMessage, '{"weird":true}');
  } finally { delete process.env.DIAG_TEST_SECRET; }
});

test('the runtime snapshot contains only booleans and plain numbers, and never an environment variable', async () => {
  process.env.DIAG_TEST_SECRET = 'super-secret-value-123';
  try {
    const snapshot = await collectRuntimeSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['arch', 'cgroupReadable', 'cwdWritable', 'memoryLimitDetectedMb', 'nodeVersion', 'osTotalMemoryMb', 'platform', 'procReadable', 'storageDirPresent', 'tmpWritable']);
    for (const [key, value] of Object.entries(snapshot)) assert.ok(['string', 'boolean', 'number'].includes(typeof value) || value === null, key);
    assert.equal(snapshot.tmpWritable, true);
    assert.ok(!JSON.stringify(snapshot).includes('super-secret-value-123'));
  } finally { delete process.env.DIAG_TEST_SECRET; }
});

test('an invalid website is still rejected outright, not turned into a failure result', async () => {
  await assert.rejects(() => createDiscoveryCrawler('crawlee', { loadCrawlee: async () => real }).crawl('http://localhost/', options()), /publiek websitedomein/i);
});
