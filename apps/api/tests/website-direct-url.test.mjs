import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, html } from './helpers/test-app.mjs';

/**
 * The exact production regression this file exists to prevent: a user enters a specific,
 * already-known vacancy detail URL (https://www.werkenbijspie.nl/vacatures/commercie-en-advies/
 * tender-manager-hengelo-1) whose site has no *static* link anywhere pointing at it — the real
 * site's vacancy listing is entirely rendered by a client-side JS widget, invisible to a static
 * HTML crawl. Before the fix, crawlWebsite() always reset to the site's bare homepage and could
 * spend its entire page budget without ever reaching the one page the user actually asked about
 * — "pages visited: 10, records found: 0" even though the page itself is a perfectly real,
 * complete vacancy. See packages/discovery-core/src/crawler/url-policy.ts's `requestedPage`.
 */
function jobPostingPage(title, company, location) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
  });
  return `<html><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head>
    <body><a href="mailto:jobs@acme-careers.example">Apply</a></body></html>`;
}

async function createWorkspaceAndProject(request, domain = 'vacancies') {
  const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Vacancy scan', domain } })).body;
  return { workspace, project };
}

test('a direct vacancy detail URL with no static link anywhere pointing at it is still found and saved — the werkenbijspie.nl regression', async () => {
  const deepPath = '/vacatures/commercie-en-advies/tender-manager-hengelo-1';
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    // The homepage links only to unrelated pages — never the deep vacancy URL itself, exactly
    // like a real site whose vacancy listing is rendered client-side (no static <a href> at all).
    '/': { body: html([['/about', 'About']]) },
    '/about': { body: html([]) },
    [deepPath]: { body: jobPostingPage('Tender Manager', 'ACME', 'Hengelo') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: `https://acme-careers.example${deepPath}` } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1, 'the direct URL must be fetched and extracted even though nothing links to it');

    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body.length, 1);
    assert.equal(records.body[0].display_name, 'Tender Manager');
  } finally { await close(); }
});

test('website-mode run stats report per-page extraction diagnostics (pagesWithVacancySignals, pagesAccepted, pagesRejected, rejectionReasons)', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/role', 'Role'], ['/over-ons', 'Over ons']]) },
    '/vacatures/role': { body: jobPostingPage('Support Engineer', 'ACME', 'Utrecht') },
    '/over-ons': { body: '<html><head><title>Over ons</title></head><body><p>Wij zijn een modern bedrijf.</p></body></html>' },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.pagesAccepted, 1);
    assert.ok(run.body.stats.pagesRejected >= 1);
    assert.ok(run.body.stats.pagesWithVacancySignals >= 1);
    assert.ok(run.body.stats.rejectionReasons && typeof run.body.stats.rejectionReasons === 'object');
    assert.ok(Array.isArray(run.body.stats.pageDiagnostics));
    const accepted = run.body.stats.pageDiagnostics.find(d => d.url.endsWith('/vacatures/role'));
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.titleFound, true);
    // Never the raw page HTML or personal data — just counts/booleans/a reason code.
    assert.equal(Object.prototype.hasOwnProperty.call(accepted, 'html'), false);
  } finally { await close(); }
});
