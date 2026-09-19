import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankVacancyCandidate, vacanciesCrawlerConfig } from '../dist/index.js';
import { crawlWebsite, CandidateQueue } from '@discovery-platform/core';
import { createHash } from 'node:crypto';

const rank = (path, source = 'link', label = '') => rankVacancyCandidate({ url: `https://example.com${path}`, source, label, discoveredFrom: 'https://example.com/' });
const contactNormalizers = { normalizeEmail: () => null, normalizePhone: () => null };
const html = links => `<html><head><title>Test</title></head><body>${links.map(path => `<a href="${path}">${path}</a>`).join('')}</body></html>`;
function fixture(pages, extra = {}) {
  let now = 0;
  return {
    ...vacanciesCrawlerConfig, contactNormalizers, extract: page => page.url,
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    transport: async url => {
      const path = new URL(url).pathname;
      const body = path === '/robots.txt' ? 'User-agent: *\nAllow: /' : pages[path];
      return { status: body === undefined ? 404 : 200, headers: { 'content-type': path.endsWith('.xml') ? 'application/xml' : path.endsWith('.txt') ? 'text/plain' : 'text/html' }, body: Buffer.from(body ?? '') };
    }, ...extra,
  };
}

test('domain evidence ranks detail, sitemap and title above navigation without hostname rules', () => {
  const detail = rank('/vacatures/adviseur-123');
  assert.ok(detail.score >= 60);
  for (const path of ['/', '/contact', '/privacy', '/nieuws/artikel', '/vacatures', '/vacatures?page=2', '/vacatures?filter=it']) assert.ok(rank(path).score < detail.score, path);
  assert.ok(rank('/vacatures/adviseur-123', 'sitemap').score > detail.score);
  assert.ok(rank('/positie/123', 'listing', 'Senior Engineer').score > rank('/positie/123').score);
});

test('bounded queue deduplicates, promotes new evidence and replaces low confidence', () => {
  const q = new CandidateQueue(2);
  const c = (url, candidateScore) => ({ url, canonicalUrl: url, candidateScore, candidateReasons: [], classification: 'general', source: 'link', label: '', discoveredFrom: '' });
  q.offer(c('low', 1)); q.offer(c('same', 2)); q.offer(c('same', 30));
  assert.equal(q.size, 2);
  q.offer(c('new', 50));
  assert.equal(q.take(new Set()).url, 'new');
  assert.equal(q.take(new Set()).url, 'same');
  assert.equal(q.take(new Set()), undefined);
});

test('requested page first; sitemap and newly discovered details precede old navigation; duplicate URLs fetched once', async () => {
  const result = await crawlWebsite('https://example.com/start', fixture({
    '/start': html(['/contact', '/vacatures', '/vacatures?a=1#top', '/contact#again']),
    '/sitemap.xml': '<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>',
    '/child.xml': '<urlset><url><loc>https://example.com/vacatures/first-123</loc></url><url><loc>https://other.test/no</loc></url></urlset>',
    '/vacatures/first-123': html(['/vacatures/new-456']),
    '/vacatures/new-456': html([]), '/vacatures': html([]), '/contact': html([]), '/': html([]),
  }));
  const paths = result.records.filter(r => r.kind === 'page').map(r => new URL(r.url).pathname);
  assert.deepEqual(paths.slice(0, 3), ['/start', '/vacatures/first-123', '/vacatures/new-456']);
  assert.equal(paths.filter(p => p === '/contact').length, 1);
  assert.equal(result.discoveryStats.sitemapUrlsFound, 2);
  assert.equal(result.discoveryStats.sitemapCandidatesAccepted, 1);
  assert.equal(result.discoveryStats.sitemapCandidatesRejected, 1);
  assert.equal(result.discoveryStats.candidatesRemaining, 0);
  assert.equal(result.stopReason, 'no_more_candidates');
  assert.ok(result.records.find(r => r.url.endsWith('/first-123')).candidateReasons.includes('sitemap_detail'));
});

test('listing discovery retains all details; stopping skips unnecessary sitemap requests', async () => {
  const paths = ['/vacatures/a', '/vacatures/b', '/vacatures/c'];
  const result = await crawlWebsite('https://example.com/vacatures', fixture({
    '/vacatures': html([...paths, '/privacy', '/vacatures']),
    ...Object.fromEntries(paths.map(path => [path, html([])])),
  }, { shouldContinue: facts => facts.length < 2 }));
  assert.equal(result.stopReason, 'target_reached');
  assert.ok(result.discoveryStats.listingUrlsFound >= 3);
  assert.equal(result.discoveryStats.highConfidenceCandidates, 3);
  const direct = await crawlWebsite('https://example.com/vacatures/a', fixture({ '/vacatures/a': html([]) }, { shouldContinue: () => false }));
  assert.equal(direct.records.filter(r => r.kind === 'sitemap').length, 0);
});

test('page and time limits remain explicit and remaining queue excludes processed URLs', async () => {
  const pages = { '/': html(['/vacatures/a', '/vacatures/b']), '/vacatures/a': html([]), '/vacatures/b': html([]) };
  const page = await crawlWebsite('https://example.com', fixture(pages, { maxPages: 1 }));
  assert.equal(page.stopReason, 'page_limit');
  assert.equal(page.discoveryStats.candidatesRemaining, 2);
  const time = await crawlWebsite('https://example.com', fixture(pages, { maxDurationMs: 3000 }));
  assert.equal(time.stopReason, 'time_limit');
});

test('incremental stats distinguish known URLs from verified unchanged content', async () => {
  const body = html(['/vacatures/a']);
  const knownCandidates = new Map([
    ['https://example.com/', createHash('sha256').update(body).digest('hex')],
    ['https://example.com/vacatures/a', null],
  ]);
  const result = await crawlWebsite('https://example.com', fixture({ '/': body, '/vacatures/a': html(['/vacatures/b']), '/vacatures/b': html([]) }, { knownCandidates }));
  assert.equal(result.discoveryStats.knownCandidates, 2);
  assert.equal(result.discoveryStats.newCandidates, 1);
  assert.equal(result.discoveryStats.unchangedCandidates, 1);
});
