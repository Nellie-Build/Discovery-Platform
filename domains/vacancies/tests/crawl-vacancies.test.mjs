import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlWebsite, linkPriority } from '@discovery-platform/core';
import { vacanciesCrawlerConfig } from '../dist/config.js';
import { extractVacancy } from '../dist/extract-vacancy.js';

function html(links) {
  return `<html><head><title>T</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
}
function site(pages) {
  return async url => {
    const page = pages[new URL(url).pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body ?? html([])) };
  };
}
function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, sleep: async ms => { now += ms; } };
}
const normalizers = {
  // A leading `+` is kept as an explicit international number; a local number with no `+` stays
  // local — never guess a country code.
  normalizePhone(raw) { const d = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, ''); return /^\+?\d{8,15}$/.test(d) ? d : null; },
  normalizeEmail(raw) { const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null; },
};
const pageUrls = result => result.records.filter(r => r.kind === 'page').map(r => new URL(r.url).pathname);

// ─── D: link priority — /vacatures/... and /careers/... are prioritized within vacancies ────
test('D: /vacatures/... and /careers/... are visited ahead of an unrelated page when vacanciesCrawlerConfig is used', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/blog/company-news'], ['/vacatures/frontend-developer'], ['/careers/overview']]) },
    '/blog/company-news': {}, '/vacatures/frontend-developer': {}, '/careers/overview': {},
  };
  const result = await crawlWebsite('https://example.com', {
    transport: site(pages), clock: fakeClock(), contactNormalizers: normalizers, extract: extractVacancy,
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
  });
  // Both vacancy-shaped pages (priority 1) are visited before the unrelated blog post (default 10).
  assert.deepEqual(pageUrls(result), ['/', '/vacatures/frontend-developer', '/careers/overview', '/blog/company-news']);
});

test('the bare discovery-core linkPriority, with no vacancies config, has no notion of "/vacatures/" or "/careers/" at all', () => {
  for (const path of ['/vacatures/frontend-developer', '/careers/overview', '/jobs/list', '/werken-bij']) {
    assert.equal(linkPriority(`https://example.com${path}`), 10, path);
  }
  // With vacancies' own config, every one of these gets the same elevated priority (1).
  for (const path of ['/vacatures/frontend-developer', '/careers/overview', '/jobs/list', '/werken-bij']) {
    assert.equal(linkPriority(`https://example.com${path}`, '', vacanciesCrawlerConfig.linkPriorityExtraTiers), 1, path);
  }
});

test('a full crawl through discovery-core, using only vacancies\' extract() and config, recognizes a real JSON-LD vacancy page reached via the homepage', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/frontend-developer', 'Vacatures']]) },
    '/vacatures/frontend-developer': { body: `<html><head><title>Frontend Developer</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Frontend Developer',
        hiringOrganization: { '@type': 'Organization', name: 'Acme Software' },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Utrecht' } },
      })}</script></head><body><a href="mailto:vacatures@acme-software.example">Solliciteer</a></body></html>` },
  };
  const result = await crawlWebsite('https://acme-software.example', {
    transport: site(pages), clock: fakeClock(), contactNormalizers: normalizers, extract: extractVacancy,
    linkPriorityExtraTiers: vacanciesCrawlerConfig.linkPriorityExtraTiers,
  });
  assert.equal(result.status, 'succeeded');
  const vacancyPage = result.extractedPages.find(p => p.url.includes('/vacatures/'));
  assert.ok(vacancyPage, 'the vacancy page should have produced VacancyFacts');
  assert.equal(vacancyPage.data.title, 'Frontend Developer');
  assert.equal(vacancyPage.data.company, 'Acme Software');
  assert.equal(vacancyPage.data.location, 'Utrecht');
  assert.equal(vacancyPage.data.email, 'vacatures@acme-software.example');
  // The homepage itself has no vacancy-specific content and must not produce a false positive.
  assert.equal(result.extractedPages.some(p => p.url === result.homepage), false);
});
