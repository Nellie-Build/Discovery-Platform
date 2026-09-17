import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlWebsite, CRAWL_POLICY } from '../dist/crawler/website-crawler.js';

function html(links) {
  return `<html><head><title>T</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
}
/** Injectable transport that serves an in-memory site keyed by pathname. */
function site(pages) {
  return async url => {
    const page = pages[new URL(url).pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return {
      status: page.status ?? 200,
      headers: { 'content-type': page.contentType ?? 'text/html', ...(page.headers ?? {}) },
      body: Buffer.from(page.body ?? html([])),
    };
  };
}
/** Deterministic, instant clock: sleep() advances virtual time instead of waiting for real time. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, sleep: async ms => { now += ms; } };
}
const pageUrls = result => result.records.filter(r => r.kind === 'page').map(r => new URL(r.url).pathname);
const normalizePhone = raw => { const d = raw.replace(/[^\d+]/g, ''); return /^\+?\d{8,15}$/.test(d) ? (d.startsWith('+') ? d : '+' + d) : null; };
const normalizeEmail = raw => { const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null; };
const contactNormalizers = { normalizePhone, normalizeEmail };
// A minimal stand-in "domain": every page's <title> becomes its one extracted fact. Proves the
// injection seam works without this package knowing or caring what the fact actually means.
const titleExtract = page => ({ title: page.$('title').first().text() || undefined });

test('crawls the homepage first, stays on-domain, prioritizes contact/about/reservation, and follows sitemap.xml', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset><url><loc>https://example.com/from-sitemap</loc></url></urlset>' },
    '/': { body: html([['https://other-domain.com/ignored'], ['/random-page'], ['/contact'], ['/about'], ['/reservation']]) },
    '/contact': {}, '/about': {}, '/reservation': {}, '/random-page': {}, '/from-sitemap': {},
  };
  const result = await crawlWebsite('https://example.com', { transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.pagesVisited, 6);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, null);
  assert.deepEqual(pageUrls(result), ['/', '/contact', '/about', '/reservation', '/random-page', '/from-sitemap']);
  assert.ok(!result.records.some(r => r.url.includes('other-domain.com')), 'cross-domain link must never be requested');
  assert.ok(result.records.some(r => r.kind === 'robots' && r.url.endsWith('/robots.txt') && r.status === 'ok'));
  assert.ok(result.records.some(r => r.kind === 'sitemap' && r.url.endsWith('/sitemap.xml') && r.status === 'ok'));
  // Every visited page handed its title to the injected extract() — this package never
  // interprets or merges that data itself.
  assert.equal(result.extractedPages.length, 6);
  assert.ok(result.extractedPages.every(p => p.data.title === 'T'));
});

test('a direct deep URL is fetched first, as page 1 — never discarded down to just the homepage before the crawl even starts', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    // No link anywhere on the homepage points at this deep page — the only way to ever reach it
    // is by fetching the literal URL the caller asked for, not by discovering it via link-following.
    '/': { body: html([['/about']]) },
    '/vacatures/commercie-en-advies/tender-manager-hengelo-1': { body: html([]) },
    '/about': {},
  };
  const result = await crawlWebsite('https://example.com/vacatures/commercie-en-advies/tender-manager-hengelo-1', {
    transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract,
  });
  assert.equal(pageUrls(result)[0], '/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  // The site's real homepage is still queued as a normal candidate afterwards, so its own
  // navigation links stay discoverable within the remaining page budget.
  assert.ok(pageUrls(result).includes('/'));
  assert.ok(pageUrls(result).includes('/about'));
});

test('a bare origin URL (no path) behaves exactly as before — the homepage is still page 1, never duplicated as its own separate candidate', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/about']]) },
    '/about': {},
  };
  const result = await crawlWebsite('https://example.com', { transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract });
  assert.deepEqual(pageUrls(result), ['/', '/about']);
});

test('linkPriorityExtraTiers changes which candidate page the crawler visits next, without this package defining the category itself', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/blog-post'], ['/vacatures']]) },
    '/blog-post': {}, '/vacatures': {},
  };
  const result = await crawlWebsite('https://example.com', {
    transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract,
    linkPriorityExtraTiers: [{ pattern: /vacatures/, priority: 1 }],
  });
  // /vacatures (priority 1, via the extra tier) is visited before /blog-post (priority 10,
  // default) even though it was discovered second.
  assert.deepEqual(pageUrls(result), ['/', '/vacatures', '/blog-post']);
});

test('respects robots.txt disallow rules without spending the page budget on blocked URLs', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /blocked' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/blocked'], ['/contact']]) },
    '/contact': {}, '/blocked': {},
  };
  const result = await crawlWebsite('https://example.com', { transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract });
  assert.equal(result.status, 'partial');
  assert.equal(result.pagesVisited, 2);
  assert.match(result.error, /Geblokkeerd door robots\.txt/);
  const blocked = result.records.find(r => r.url.endsWith('/blocked'));
  assert.equal(blocked.attempted, false);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error, /robots\.txt/);
});

test('visits at most 10 pages, always starting from the homepage', async () => {
  const fillers = Array.from({ length: 15 }, (_, i) => `/page${i}`);
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html(fillers.map(p => [p])) },
  };
  for (const p of fillers) pages[p] = {};
  const result = await crawlWebsite('https://example.com', { transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract });
  assert.equal(CRAWL_POLICY.maxPages, 10);
  assert.equal(result.pagesVisited, 10);
  assert.equal(result.status, 'succeeded');
  assert.equal(pageUrls(result)[0], '/');
  assert.equal(result.records.filter(r => r.kind === 'page').length, 10);
});

test('applies normal rate limiting between every request, including robots/sitemap fetches', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/a'], ['/b']]) },
    '/a': {}, '/b': {},
  };
  const clock = fakeClock();
  const result = await crawlWebsite('https://example.com', { transport: site(pages), clock, contactNormalizers, extract: titleExtract });
  const times = result.records.map(r => new Date(r.fetchedAt).getTime());
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= CRAWL_POLICY.minDelayMs, `expected >= ${CRAWL_POLICY.minDelayMs}ms gap at index ${i}`);
  }
});

test('reports a blocked status when robots.txt itself cannot be fetched (fail closed)', async () => {
  const result = await crawlWebsite('https://example.com', {
    transport: async () => { throw new Error('getaddrinfo ENOTFOUND example.com'); },
    clock: fakeClock(), contactNormalizers, extract: titleExtract,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.pagesVisited, 0);
});

test('extracts and merges contact details found across crawled pages, preferring the contact page', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: `<html><body>${['/contact', '/about'].map(h => `<a href="${h}">${h}</a>`).join('')}<p>General: 15550000000</p></body></html>` },
    '/contact': { body: `<html><body>
      <a href="mailto:info@test-example.com">Email</a>
      <a href="tel:15551234567">Call</a>
      <a href="https://wa.me/15551234567">WhatsApp</a>
      <a href="https://www.instagram.com/example_business">Instagram</a>
      <a href="https://www.facebook.com/ExampleBusiness">Facebook</a>
    </body></html>` },
    '/about': { body: '<html><body>About us.</body></html>' },
  };
  const result = await crawlWebsite('https://test-example.com', { transport: site(pages), clock: fakeClock(), contactNormalizers, extract: titleExtract });
  assert.deepEqual(result.contacts, {
    email: 'info@test-example.com',
    phone: '+15551234567', // the contact page's tel: link wins over the homepage's plain-text number
    whatsapp: '+15551234567',
    instagram: 'https://instagram.com/example_business',
    facebook: 'https://facebook.com/ExampleBusiness',
  });
});

test("extract() returning undefined for a page, or an array of several facts for one page, is handled as documented", async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: '<html><head><title>Home</title></head><body><a href="/multi">multi</a></body></html>' },
    '/multi': { body: '<html><head><title>Multi</title></head><body>nothing relevant here</body></html>' },
  };
  const result = await crawlWebsite('https://example.com', {
    transport: site(pages), clock: fakeClock(), contactNormalizers,
    extract: page => page.url.endsWith('/multi') ? [{ n: 1 }, { n: 2 }] : undefined,
  });
  assert.deepEqual(result.extractedPages.filter(p => p.url.endsWith('/multi')).map(p => p.data), [{ n: 1 }, { n: 2 }]);
  assert.equal(result.extractedPages.some(p => p.url === result.homepage), false);
});

test('reports a failed status when the site is reachable but every page request errors', async () => {
  const result = await crawlWebsite('https://example.com', {
    transport: async url => {
      if (new URL(url).pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /') };
      throw new Error('socket hang up');
    },
    clock: fakeClock(), contactNormalizers, extract: titleExtract,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.pagesVisited, 1);
  assert.match(result.error, /socket hang up/);
});
