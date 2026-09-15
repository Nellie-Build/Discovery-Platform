import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlVacancies } from '../crawl-vacancies.mjs';

function html(links) {
  return `<html><head><title>T</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
}
function fakeSite(pages) {
  return async url => {
    const page = pages[new URL(url).pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body ?? html([])) };
  };
}
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };

test('crawlVacancies finds a JSON-LD vacancy on a careers page reached from the homepage, and returns VacancyFacts[]', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/careers/backend-engineer', 'Careers']]) },
    '/careers/backend-engineer': { body: `<html><head><title>Backend Engineer</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org/', '@type': 'JobPosting', title: 'Backend Engineer',
        hiringOrganization: { '@type': 'Organization', name: 'Example Corp' },
      })}</script></head><body></body></html>` },
  };
  const result = await crawlVacancies('https://example-corp.test', { transport: fakeSite(pages), clock: fakeClock() });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.vacancies.length, 1);
  assert.equal(result.vacancies[0].title, 'Backend Engineer');
  assert.equal(result.vacancies[0].company, 'Example Corp');
});
