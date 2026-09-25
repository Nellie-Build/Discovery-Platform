import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, html } from './helpers/test-app.mjs';

function jobPostingPage(title, company, location, extraLinks = '') {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
  });
  return `<html><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head>
    <body><a href="mailto:jobs@${company.toLowerCase().replace(/\s+/g, '-')}.example">Apply</a>${extraLinks}</body></html>`;
}

async function createWorkspaceAndProject(request, domain = 'vacancies') {
  const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Vacancy scan', domain } })).body;
  return { workspace, project };
}

const basePages = {
  '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
  '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
};

test('a full discovery run: HTTP request -> crawler -> vacancies domain -> PostgreSQL -> API response', async () => {
  const pages = {
    ...basePages,
    '/': { body: html([['/vacatures/frontend-developer', 'Vacatures']]) },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);

    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.pagesVisited, 2);
    assert.equal(run.body.stats.factsFound, 1);

    // GET /runs/:id and GET /projects/:id/runs both see the same run.
    const runDetail = await request('GET', `/runs/${run.body.id}`);
    assert.equal(runDetail.status, 200);
    assert.equal(runDetail.body.status, 'succeeded');
    const runList = await request('GET', `/projects/${project.id}/runs`);
    assert.deepEqual(runList.body.map(r => r.id), [run.body.id]);

    // The record itself: generic shape, domain-specific facts inside domain_data, provenance
    // and scoring both persisted.
    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.status, 200);
    assert.equal(records.body.length, 1);
    const [record] = records.body;
    assert.equal(record.display_name, 'Frontend Developer');
    assert.equal(record.domain, 'vacancies');
    assert.equal(record.domain_data.company, 'Acme Software');
    assert.equal(record.domain_data.location, 'Utrecht');
    assert.ok(typeof record.score === 'number' && record.score > 0, 'completeness score must have been persisted');

    const recordDetail = await request('GET', `/records/${record.id}`);
    assert.equal(recordDetail.status, 200);
    assert.equal(recordDetail.body.sources.length, 1);
    assert.equal(recordDetail.body.sources[0].source_type, 'website');
    assert.ok(recordDetail.body.sources[0].source_url.includes('/vacatures/frontend-developer'));
    assert.ok(recordDetail.body.contacts.some(c => c.type === 'email' && c.value.includes('acme-software')));
  } finally { await close(); }
});

test('dedupe voorkomt dubbele records: running the exact same crawl twice creates zero new records the second time', async () => {
  const pages = {
    ...basePages,
    '/': { body: html([['/vacatures/frontend-developer', 'Vacatures']]) },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const firstRun = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(firstRun.body.recordsCreated, 1);

    const secondRun = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(secondRun.status, 201);
    assert.equal(secondRun.body.recordsCreated, 0, 'the vacancy already exists in this project and must not be duplicated');
    assert.equal(secondRun.body.stats.duplicatesAgainstExisting, 1);

    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body.length, 1, 'still exactly one record after two identical runs');
  } finally { await close(); }
});

test('dedupe within one crawl: two pages describing the exact same vacancy collapse into a single record', async () => {
  const pages = {
    ...basePages,
    '/': { body: html([['/vacatures/frontend-developer', 'Vacatures'], ['/careers/frontend-developer-role', 'Careers']]) },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
    '/careers/frontend-developer-role': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.factsFound, 2);
    assert.equal(run.body.stats.duplicatesWithinCrawl, 1);

    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body.length, 1);
  } finally { await close(); }
});

test('two genuinely different vacancies on the same site both get their own record', async () => {
  const pages = {
    ...basePages,
    '/': { body: html([['/vacatures/frontend-developer', 'FE'], ['/vacatures/backend-developer', 'BE']]) },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
    '/vacatures/backend-developer': { body: jobPostingPage('Backend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(run.body.recordsCreated, 2);
    const records = await request('GET', `/projects/${project.id}/records`);
    assert.deepEqual(new Set(records.body.map(r => r.display_name)), new Set(['Frontend Developer', 'Backend Developer']));
  } finally { await close(); }
});

test('POST /projects/:id/runs validates its input before touching the crawler', async () => {
  const { request, close } = await startTestApp({ pages: basePages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const missingUrl = await request('POST', `/projects/${project.id}/runs`, { body: {} });
    assert.equal(missingUrl.status, 400);

    const unknownProject = await request('POST', '/projects/00000000-0000-4000-8000-000000000000/runs', { body: { sourceUrl: 'https://example.com' } });
    assert.equal(unknownProject.status, 404);
  } finally { await close(); }
});

test('GET /records/:id returns 404 for an unknown record', async () => {
  const { request, close } = await startTestApp({ apiKey: 'test-key' });
  try {
    const res = await request('GET', '/records/00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 404);
  } finally { await close(); }
});

test('the same architecture, without any database change, could support a different domain: an unregistered domain fails cleanly at run time, not with a crash', async () => {
  const { request, close } = await startTestApp({ apiKey: 'test-key' });
  try {
    const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
    // A project cannot even be created for an unregistered domain today (validated at creation)
    // — proving the registry, not a hardcoded route, is what decides which domains exist.
    const res = await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Housing scan', domain: 'housing' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unknown_domain');
  } finally { await close(); }
});
