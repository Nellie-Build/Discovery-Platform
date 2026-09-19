import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';
import { resolveDiscoveryRunConfig } from '../dist/discovery-run-config.js';

function adapter(pages) {
  let now = 0;
  return createVacanciesAdapter({
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    transport: async url => {
      const path = new URL(url).pathname;
      const body = path === '/robots.txt' ? 'User-agent: *\nAllow: /' : pages[path];
      return { status: body === undefined ? 404 : 200, headers: { 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html' }, body: Buffer.from(body ?? '') };
    },
  });
}
const input = targetRecords => ({ mode: 'website', sourceUrl: 'https://example.com/', runConfig: resolveDiscoveryRunConfig({ targetRecords }), filters: {}, existingRecords: [] });
const job = title => ({ '@type': 'JobPosting', title, hiringOrganization: { name: 'Acme' }, jobLocation: { address: { addressLocality: 'Utrecht' } } });
const page = jobs => `<html><script type="application/ld+json">${JSON.stringify(jobs)}</script></html>`;

test('multiple facts on one URL are deduplicated before target stopping and no sitemap is fetched', async () => {
  const outcome = await adapter({ '/': page([job('Engineer'), job('Accountant'), job('Designer')]) }).runDiscovery(input(1));
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.stats.recordsAccepted, 1);
  assert.equal(outcome.stats.duplicates, 2);
  assert.equal(outcome.stats.stopReason, 'target_reached');
  assert.equal(outcome.stats.budgetSource, 'adaptive');
  assert.equal(outcome.stats.pagesVisited, 1);
  assert.equal(outcome.stats.sitemapUrlsFound, 0);
});

test('ordinary Standard mode reaches target through ranked details without Advanced limits', async () => {
  const links = Array.from({ length: 12 }, (_, i) => `/vacatures/job-${i}`);
  const pages = { '/': `<html><a href="/contact">Contact</a>${links.map(path => `<a href="${path}">${path}</a>`).join('')}</html>`, '/contact': '<html>Contact</html>' };
  links.forEach((path, i) => { pages[path] = page(job(`Role ${i}`)); });
  const outcome = await adapter(pages).runDiscovery(input(10));
  assert.equal(outcome.records.length, 10);
  assert.equal(outcome.stats.pagesVisited, 11);
  assert.equal(outcome.stats.maxPages, 30);
  assert.equal(outcome.stats.stopReason, 'target_reached');
  assert.ok(outcome.stats.candidatesRemaining >= 2);
  assert.ok(outcome.stats.candidateDiagnostics.some(c => c.candidateReasons.includes('listing_detail_link')));
});
