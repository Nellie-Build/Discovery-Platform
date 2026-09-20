import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { createDiscoveryCrawler, parseCrawlerEngine } from '../dist/crawler/discovery-crawler.js';

/**
 * One contract, run against every crawl engine. The behaviour that must not depend on the engine
 * (scope, robots, SSRF, redirects, limits, ordering of the requested page, diagnostics) is asserted
 * identically for `legacy` and `crawlee`; the one deliberate difference (Crawlee retries a
 * transient failure, the legacy engine does not) is asserted per engine.
 */
const ENGINES = ['legacy', 'crawlee'];

function html(links, title = 'T') {
  return `<html><head><title>${title}</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
}
/** In-memory site keyed by pathname (+search when a key with it exists). Records every request. */
function site(pages, log = []) {
  return async (url, _userAgent) => {
    const parsed = new URL(url);
    log.push({ url, path: parsed.pathname + parsed.search });
    const page = pages[parsed.pathname + parsed.search] ?? pages[parsed.pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    if (typeof page === 'function') return page(url);
    return { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html', ...(page.headers ?? {}) }, body: Buffer.from(page.body ?? html([])) };
  };
}
const ROBOTS_OK = { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' };
const SITEMAP = urls => ({ contentType: 'application/xml', body: `<urlset>${urls.map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>` });
/** Deterministic clock: sleep() advances virtual time. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, sleep: async ms => { now += ms; } };
}
const normalizePhone = raw => { const d = raw.replace(/[^0-9+]/g, ''); return d.length >= 8 ? d : null; };
const normalizeEmail = raw => { const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return e.includes('@') ? e : null; };
const contactNormalizers = { normalizePhone, normalizeEmail };
const titleExtract = page => ({ title: page.$('title').first().text() || undefined });
const fetchedPaths = result => result.records.filter(r => r.kind === 'page' && r.attempted).map(r => new URL(r.url).pathname + new URL(r.url).search);
/** A ranking that prefers detail pages, like a domain module would supply. */
const rank = ({ url }) => {
  const path = new URL(url).pathname;
  if (/^\/detail\//.test(path)) return { score: 100, reasons: ['detail_path'], classification: 'detail' };
  if (/page=/.test(url)) return { score: 40, reasons: ['pagination'], classification: 'pagination' };
  return { score: 10, reasons: ['general'], classification: 'general' };
};

function run(engine, website, pages, extra = {}) {
  const log = [];
  const crawler = createDiscoveryCrawler(engine, { maxConcurrency: 2, maxRequestRetries: 2 });
  const promise = crawler.crawl(website, { transport: site(pages, log), clock: fakeClock(), contactNormalizers, extract: titleExtract, ...extra });
  return promise.then(result => ({ result, log }));
}

test('engine selection: crawlee is the default and only an explicit "legacy" selects the rollback engine', () => {
  assert.equal(parseCrawlerEngine(undefined), 'crawlee');
  assert.equal(parseCrawlerEngine(null), 'crawlee');
  assert.equal(parseCrawlerEngine(''), 'crawlee');
  assert.equal(parseCrawlerEngine('   '), 'crawlee');
  assert.equal(parseCrawlerEngine('crawlee'), 'crawlee');
  assert.equal(parseCrawlerEngine(' Crawlee '), 'crawlee');
  assert.equal(parseCrawlerEngine('legacy'), 'legacy');
  assert.equal(parseCrawlerEngine(' LEGACY '), 'legacy');
  // A typo is not a rollback: an unrecognised value is the product default.
  assert.equal(parseCrawlerEngine('legcy'), 'crawlee');
  assert.equal(parseCrawlerEngine('crawle'), 'crawlee');
  assert.equal(parseCrawlerEngine('old'), 'crawlee');
  assert.equal(createDiscoveryCrawler().engine, 'crawlee');
  assert.equal(createDiscoveryCrawler('legacy').engine, 'legacy');
  assert.equal(createDiscoveryCrawler('crawlee').engine, 'crawlee');
});

for (const engine of ENGINES) {
  test(`[${engine}] the requested URL is the first page processed, even when it is a deep link`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/detail/1'], ['/other']]) },
      '/detail/deep': { body: html([['/detail/1']], 'Deep') },
      '/detail/1': {}, '/other': {},
    };
    const { result } = await run(engine, 'https://example.com/detail/deep', pages, { rankCandidate: rank });
    assert.equal(fetchedPaths(result)[0], '/detail/deep');
    assert.equal(result.extractedPages[0].url, 'https://example.com/detail/deep');
    assert.equal(result.extractedPages[0].data.title, 'Deep');
    assert.ok(fetchedPaths(result).includes('/'), 'the homepage is still crawled afterwards');
  });

  test(`[${engine}] the requested page is fetched alone, before any other page, and the sitemap is read after it`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP(['https://example.com/from-sitemap']),
      '/': { body: html([['/a'], ['/b']]) }, '/a': {}, '/b': {}, '/from-sitemap': {},
    };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    const order = log.map(entry => entry.path);
    assert.equal(order[0], '/robots.txt');
    assert.equal(order[1], '/');
    assert.ok(order.indexOf('/sitemap.xml') > order.indexOf('/'), 'sitemap discovery follows the first page');
    assert.ok(result.extractedPages.length >= 4);
  });

  test(`[${engine}] sitemap discovery finds pages no link points to`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP(['https://example.com/only-in-sitemap']),
      '/': { body: html([]) }, '/only-in-sitemap': {},
    };
    const { result } = await run(engine, 'https://example.com/', pages);
    assert.ok(fetchedPaths(result).includes('/only-in-sitemap'));
    assert.equal(result.discoveryStats.sitemapUrlsFound, 1);
  });

  test(`[${engine}] a sitemap index is followed to its child sitemaps`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK,
      '/sitemap.xml': { contentType: 'application/xml', body: '<sitemapindex><sitemap><loc>https://example.com/sitemap-jobs.xml</loc></sitemap></sitemapindex>' },
      '/sitemap-jobs.xml': SITEMAP(['https://example.com/detail/from-child']),
      '/': { body: html([]) }, '/detail/from-child': {},
    };
    const { result } = await run(engine, 'https://example.com/', pages, { rankCandidate: rank });
    assert.ok(fetchedPaths(result).includes('/detail/from-child'));
    assert.ok(result.records.some(r => r.kind === 'sitemap' && r.url.endsWith('/sitemap-jobs.xml')));
  });

  test(`[${engine}] links are discovered and followed, off-domain links never are`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/a'], ['https://other-domain.com/x'], ['mailto:someone@example.com']]) }, '/a': { body: html([['/b']]) }, '/b': {},
    };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    assert.deepEqual(fetchedPaths(result).sort(), ['/', '/a', '/b']);
    assert.ok(!log.some(entry => entry.url.includes('other-domain')));
  });

  test(`[${engine}] pagination pages are discovered`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/list': { body: html([['/list?page=2', 'Volgende']]) }, '/list?page=2': { body: html([['/list?page=3']]) }, '/list?page=3': {},
    };
    const { result } = await run(engine, 'https://example.com/list', pages, { rankCandidate: rank });
    assert.deepEqual(fetchedPaths(result).filter(path => path.startsWith('/list')), ['/list', '/list?page=2', '/list?page=3']);
  });

  test(`[${engine}] high-priority candidates are fetched before low-priority ones`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/low-1'], ['/low-2'], ['/low-3'], ['/detail/high-1'], ['/detail/high-2'], ['/low-4']]) },
      '/low-1': {}, '/low-2': {}, '/low-3': {}, '/low-4': {}, '/detail/high-1': {}, '/detail/high-2': {},
    };
    const { result } = await run(engine, 'https://example.com/', pages, { rankCandidate: rank });
    const order = fetchedPaths(result);
    assert.equal(order[0], '/');
    const firstLow = Math.min(...order.map((path, index) => path.startsWith('/low') ? index : Infinity));
    for (const high of ['/detail/high-1', '/detail/high-2']) assert.ok(order.indexOf(high) < firstLow, `${high} before the first low-priority page: ${order.join(' ')}`);
    const recorded = result.records.find(r => r.url.endsWith('/detail/high-1'));
    assert.equal(recorded.candidateScore, 100);
    assert.deepEqual(recorded.candidateReasons, ['detail_path']);
  });

  test(`[${engine}] every URL is fetched once: utm/fragment variants, repeated links and sitemap duplicates collapse`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP(['https://example.com/a', 'https://example.com/a?utm_source=x', 'https://example.com/b']),
      '/': { body: html([['/a'], ['/a#top'], ['/a?utm_medium=y'], ['/b'], ['/b']]) }, '/a': {}, '/b': {},
    };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    assert.deepEqual(fetchedPaths(result).sort(), ['/', '/a', '/b']);
    assert.equal(log.filter(entry => entry.path === '/a').length, 1);
    assert.equal(log.filter(entry => entry.path === '/b').length, 1);
  });

  test(`[${engine}] a same-domain redirect is followed and recorded`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/old']]) },
      '/old': { status: 301, headers: { location: '/new' }, body: '' }, '/new': { body: html([], 'New') },
    };
    const { result } = await run(engine, 'https://example.com/', pages);
    assert.ok(result.records.some(r => r.url.endsWith('/old') && r.status === 'redirect' && r.redirectTo === 'https://example.com/new'));
    assert.ok(result.extractedPages.some(page => page.url === 'https://example.com/new' && page.data.title === 'New'));
  });

  test(`[${engine}] an unsafe redirect (another domain, a metadata address) is blocked and never fetched`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/to-other'], ['/to-metadata']]) },
      '/to-other': { status: 302, headers: { location: 'https://evil.example.org/steal' }, body: '' },
      '/to-metadata': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' }, body: '' },
    };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    assert.ok(!log.some(entry => /evil\.example\.org|169\.254/.test(entry.url)));
    assert.equal(result.records.filter(r => /^Redirect zonder geldige bestemming/.test(r.error ?? '')).length, 2);
  });

  test(`[${engine}] robots.txt disallow rules are respected without spending requests on blocked URLs`, async () => {
    const pages = {
      '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /private' },
      '/sitemap.xml': SITEMAP([]), '/': { body: html([['/private/a'], ['/public']]) }, '/private/a': {}, '/public': {},
    };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    assert.ok(!log.some(entry => entry.path === '/private/a'));
    assert.ok(result.records.some(r => r.url.endsWith('/private/a') && !r.attempted && /robots/i.test(r.error ?? '')));
    assert.ok(fetchedPaths(result).includes('/public'));
  });

  test(`[${engine}] an unreadable robots.txt fails closed`, async () => {
    const pages = { '/robots.txt': { status: 500, contentType: 'text/plain', body: 'boom' }, '/': {} };
    const { result } = await run(engine, 'https://example.com/', pages);
    assert.equal(result.status, 'blocked');
    assert.equal(result.stopReason, 'robots_blocked');
    assert.equal(result.extractedPages.length, 0);
  });

  test(`[${engine}] a failed page request is reported and the crawl carries on`, async () => {
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/gone'], ['/fine']]) }, '/gone': { status: 404 }, '/fine': {},
    };
    const { result } = await run(engine, 'https://example.com/', pages);
    assert.equal(result.status, 'partial');
    assert.ok(result.records.some(r => r.url.endsWith('/gone') && r.status === 'http_error' && r.httpStatus === 404));
    assert.ok(fetchedPaths(result).includes('/fine'));
    assert.equal(result.crawlerStats.requestsFailed, 1);
    assert.equal(result.crawlerStats.requestsRetried, 0, 'a 404 is not a transient failure');
  });

  test(`[${engine}] a transient failure: ${engine === 'crawlee' ? 'retried and then succeeds' : 'reported (the legacy engine does not retry)'}`, async () => {
    let attempts = 0;
    const pages = {
      '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]),
      '/': { body: html([['/flaky']]) },
      '/flaky': () => { attempts++; if (attempts === 1) throw new Error('socket hang up'); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html([], 'Recovered')) }; },
    };
    const { result } = await run(engine, 'https://example.com/', pages);
    if (engine === 'crawlee') {
      assert.equal(result.crawlerStats.requestsRetried, 1);
      assert.equal(attempts, 2);
      assert.ok(result.extractedPages.some(page => page.data.title === 'Recovered'));
      assert.equal(result.records.filter(r => r.url.endsWith('/flaky') && r.status === 'failed').length, 1, 'the failed attempt stays visible');
    } else {
      assert.equal(result.crawlerStats.requestsRetried, 0);
      assert.equal(attempts, 1);
      assert.ok(!result.extractedPages.some(page => page.data.title === 'Recovered'));
    }
    assert.equal(result.crawlerStats.requestsFailed, 1);
  });

  test(`[${engine}] the page limit is respected exactly`, async () => {
    const links = Array.from({ length: 12 }, (_, i) => [`/p${i}`]);
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html(links) } };
    for (let i = 0; i < 12; i++) pages[`/p${i}`] = {};
    const { result } = await run(engine, 'https://example.com/', pages, { maxPages: 4 });
    assert.equal(result.pagesVisited, 4);
    assert.equal(fetchedPaths(result).length, 4);
    assert.equal(result.stopReason, 'page_limit');
    assert.ok(result.crawlerStats.queueRemaining > 0);
  });

  test(`[${engine}] the candidate limit is respected and reported`, async () => {
    const links = Array.from({ length: 30 }, (_, i) => [`/c${i}`]);
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html(links) } };
    for (let i = 0; i < 30; i++) pages[`/c${i}`] = {};
    const { result } = await run(engine, 'https://example.com/', pages, { maxCandidates: 5, maxPages: 100 });
    assert.equal(result.candidateLimitReached, true);
    assert.equal(result.stopReason, 'candidate_limit');
    assert.ok(result.pagesVisited <= 1 + 5 + 1);
  });

  test(`[${engine}] the time limit stops the crawl without shortening the crawl delay`, async () => {
    const links = Array.from({ length: 20 }, (_, i) => [`/t${i}`]);
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html(links) } };
    for (let i = 0; i < 20; i++) pages[`/t${i}`] = {};
    const { result } = await run(engine, 'https://example.com/', pages, { maxDurationMs: 9_000, maxPages: 100 });
    assert.equal(result.stopReason, 'time_limit');
    assert.ok(result.pagesVisited < 20);
    assert.ok(result.crawlerStats.durationMs <= 9_000 + 2_000);
  });

  test(`[${engine}] when the target is reached no new page requests are started`, async () => {
    const links = Array.from({ length: 15 }, (_, i) => [`/d${i}`]);
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html(links) } };
    for (let i = 0; i < 15; i++) pages[`/d${i}`] = {};
    const { result } = await run(engine, 'https://example.com/', pages, { maxPages: 50, shouldContinue: extracted => extracted.length < 3 });
    assert.equal(result.stopReason, 'target_reached');
    assert.ok(result.extractedPages.length >= 3 && result.extractedPages.length <= 3 + 2, `extracted ${result.extractedPages.length}`);
    assert.ok(result.pagesVisited <= 3 + 2, `pages ${result.pagesVisited}`);
  });

  test(`[${engine}] the queue running dry is reported as no_more_candidates`, async () => {
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html([['/only']]) }, '/only': {} };
    const { result } = await run(engine, 'https://example.com/', pages);
    assert.equal(result.stopReason, 'no_more_candidates');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.crawlerStats.queueRemaining, 0);
  });

  test(`[${engine}] diagnostics: engine, request counts, concurrency, queue and duration are reported`, async () => {
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html([['/a'], ['/b'], ['/gone']]) }, '/a': {}, '/b': {}, '/gone': { status: 404 } };
    const { result, log } = await run(engine, 'https://example.com/', pages);
    const stats = result.crawlerStats;
    assert.equal(stats.crawlerEngine, engine);
    assert.equal(stats.requestsStarted, log.length, 'every request is counted once');
    assert.equal(stats.requestsSucceeded + stats.requestsFailed, stats.requestsStarted);
    assert.equal(stats.requestsFailed, 1);
    assert.ok(stats.requestsQueued >= 4);
    assert.ok(stats.maxConcurrencyUsed >= 1 && stats.maxConcurrencyUsed <= (engine === 'legacy' ? 1 : 3));
    assert.equal(typeof stats.queueRemaining, 'number');
    assert.equal(typeof stats.durationMs, 'number');
    // The domain-level stats stay exactly as they were.
    assert.equal(result.pagesVisited, 4);
    assert.equal(result.discoveryStats.candidatesProcessed, 4);
    assert.ok(result.contacts && Array.isArray(result.candidates));
  });

  test(`[${engine}] the crawl delay holds between request starts, however many pages are in flight`, async () => {
    const clock = fakeClock();
    const starts = [];
    const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html([['/a'], ['/b'], ['/c'], ['/d']]) }, '/a': {}, '/b': {}, '/c': {}, '/d': {} };
    const inner = site(pages);
    const crawler = createDiscoveryCrawler(engine, { maxConcurrency: 3 });
    await crawler.crawl('https://example.com/', { clock, contactNormalizers, extract: titleExtract, transport: async (url, agent) => { starts.push(clock.now()); return inner(url, agent); } });
    assert.ok(starts.length >= 6);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2000, `request ${i} started ${starts[i] - starts[i - 1]} ms after the previous one`);
  });

  test(`[${engine}] SSRF: a non-public address is refused by the real transport, without any request being sent`, async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '172.16.0.9']) {
      const crawler = createDiscoveryCrawler(engine);
      const result = await crawler.crawl(`http://${address}/`, { contactNormalizers, extract: titleExtract, clock: fakeClock(), maxDurationMs: 60_000 });
      assert.equal(result.extractedPages.length, 0, address);
      assert.ok(result.records.every(r => !r.attempted || r.status === 'failed'), `${address}: ${JSON.stringify(result.records.map(r => [r.kind, r.status]))}`);
      assert.ok(result.records.some(r => /Niet-publiek netwerkadres/.test(r.error ?? '')), address);
      assert.equal(result.status === 'succeeded', false, address);
    }
  });

  test(`[${engine}] localhost and non-domain hosts are refused before anything is fetched`, async () => {
    const crawler = createDiscoveryCrawler(engine);
    for (const target of ['http://localhost/', 'localhost', 'http://[::1]/', 'ftp://example.com/', 'http://user:pass@example.com/']) {
      await assert.rejects(() => crawler.crawl(target, { contactNormalizers, extract: titleExtract }), /Ongeldige|publiek websitedomein|Invalid URL/i, target);
    }
  });

  test(`[${engine}] fetchPage handles exactly one page through the same policy-checked transport`, async () => {
    const crawler = createDiscoveryCrawler(engine);
    const ok = await crawler.fetchPage('https://example.com/detail/1', { contactNormalizers, extract: titleExtract, transport: site({ '/detail/1': { body: html([], 'One') } }) });
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.data[0].title, 'One');
    const refused = await crawler.fetchPage('http://10.0.0.5/x', { contactNormalizers, extract: titleExtract });
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /Niet-publiek netwerkadres/);
    const bad = await crawler.fetchPage('ftp://example.com/x', { contactNormalizers, extract: titleExtract });
    assert.equal(bad.status, 'failed');
  });
}

test('the crawlee engine keeps everything in memory: no storage directory is created', async () => {
  const before = existsSync('storage');
  const crawler = createDiscoveryCrawler('crawlee');
  await crawler.crawl('https://example.com/', { clock: fakeClock(), contactNormalizers, extract: titleExtract, transport: site({ '/robots.txt': ROBOTS_OK, '/': {} }) });
  assert.equal(existsSync('storage'), before);
});

test('both engines give the same pages for the same site (parity of results)', async () => {
  const pages = {
    '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP(['https://example.com/detail/s1', 'https://example.com/other']),
    '/': { body: html([['/detail/1'], ['/detail/2'], ['/list?page=2'], ['/x']]) },
    '/detail/1': {}, '/detail/2': {}, '/detail/s1': {}, '/list?page=2': { body: html([['/detail/3']]) }, '/detail/3': {}, '/x': {}, '/other': {},
  };
  const legacy = (await run('legacy', 'https://example.com/', pages, { rankCandidate: rank })).result;
  const crawlee = (await run('crawlee', 'https://example.com/', pages, { rankCandidate: rank })).result;
  assert.deepEqual(fetchedPaths(crawlee).sort(), fetchedPaths(legacy).sort());
  assert.equal(crawlee.status, legacy.status);
  assert.equal(crawlee.stopReason, legacy.stopReason);
  assert.equal(crawlee.pagesVisited, legacy.pagesVisited);
  assert.deepEqual(crawlee.extractedPages.map(p => p.url).sort(), legacy.extractedPages.map(p => p.url).sort());
  assert.equal(crawlee.discoveryStats.candidatesProcessed, legacy.discoveryStats.candidatesProcessed);
});

test('[crawlee] pages are fetched concurrently up to maxConcurrency, never beyond, and the reported figure matches', async () => {
  const links = Array.from({ length: 12 }, (_, i) => [`/c${i}`]);
  const pages = { '/robots.txt': ROBOTS_OK, '/sitemap.xml': SITEMAP([]), '/': { body: html(links) } };
  for (let i = 0; i < 12; i++) pages[`/c${i}`] = {};
  const inner = site(pages);
  let active = 0, peak = 0;
  const slow = async (url, agent) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return inner(url, agent);
  };
  for (const [requested, expected] of [[1, 1], [2, 2], [3, 3], [9, 3], [0, 1]]) {
    active = 0; peak = 0;
    const crawler = createDiscoveryCrawler('crawlee', { maxConcurrency: requested });
    const result = await crawler.crawl('https://example.com/', { clock: fakeClock(), contactNormalizers, extract: titleExtract, transport: slow, maxPages: 13 });
    assert.equal(result.crawlerStats.maxConcurrencyUsed, expected, `requested ${requested}`);
    assert.ok(peak <= expected + 0, `transport saw ${peak} requests at once for maxConcurrency ${requested}`);
    assert.equal(result.pagesVisited, 13);
  }
});
