import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp } from './helpers/test-app.mjs';

function jobPostingPage(title, company, location) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
  });
  return `<html><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head>
    <body><a href="mailto:jobs@${company.toLowerCase().replace(/\s+/g, '-')}.example">Apply</a></body></html>`;
}

async function createWorkspaceAndProject(request, domain = 'vacancies') {
  const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Branch scan', domain } })).body;
  return { workspace, project };
}

function fakeSearchProvider(candidates) {
  return { async search() { return candidates; } };
}

test('POST /projects/:id/runs with { branch } starts a branch search, and a real vacancy discovered via a candidate URL is saved as a record', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const pages = { '/vacatures/security-officer': { body: jobPostingPage('Security Officer', 'Acme Security', 'Den Haag') } };
  const searchProvider = fakeSearchProvider([{ url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' }]);
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key', searchProvider });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security', region: 'Nederland' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.searchMode, 'branch');
    assert.equal(run.body.stats.branch, 'Security');
    assert.equal(run.body.stats.region, 'Nederland');
    assert.equal(run.body.stats.candidatesFound, 1);

    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body.length, 1);
    assert.equal(records.body[0].display_name, 'Security Officer');
  } finally { await close(); }
});

test('POST /projects/:id/runs requires either sourceUrl or branch — an empty body is rejected before touching the crawler or search provider', async () => {
  const { request, close } = await startTestApp({ apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const res = await request('POST', `/projects/${project.id}/runs`, { body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_source');
  } finally { await close(); }
});

test('a branch search with no region still works — region is optional, not required', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const pages = { '/vacatures/security-officer': { body: jobPostingPage('Security Officer', 'Acme Security', 'Den Haag') } };
  const searchProvider = fakeSearchProvider([{ url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' }]);
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key', searchProvider });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.stats.region, null);
  } finally { await close(); }
});

test('the existing { sourceUrl } website mode is byte-for-byte unchanged: same request shape, same response shape, still works with no searchProvider configured at all', async () => {
  const pages = {
    '/': { body: '<html><head><title>T</title></head><body><a href="/vacatures/frontend-developer">x</a></body></html>' },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' }); // no searchProvider at all
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.searchMode, 'website');
  } finally { await close(); }
});

test('a branch search request when BRAVE_SEARCH_API_KEY is not configured (no searchProvider injected) fails the run cleanly, with a safe message and 201/failed — never a 500 or a crash', async () => {
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key' }); // pages given -> real adapter, but no searchProvider
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'failed');
    assert.match(run.body.error, /BRAVE_SEARCH_API_KEY/);
    assert.equal(run.body.recordsCreated, 0);
  } finally { await close(); }
});
