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

/** startTestApp defaults every test to an *empty* job-board provider unless one is given here —
 * see helpers/test-app.mjs — so these tests exercise Brave in isolation without ever calling the
 * real ts-jobspy package. */
function fakeJobBoardProvider(candidates) {
  return {
    async findCandidates() {
      return {
        candidates,
        meta: [{ provider: 'ts-jobspy', site: 'indeed', status: candidates.length ? 'ok' : 'empty', candidates: candidates.length, durationMs: 5, error: null }],
      };
    },
  };
}

test('POST /projects/:id/runs with { branch } starts a branch search, and a real vacancy discovered via a Brave candidate URL is saved as a record', async () => {
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

test('POST /projects/:id/runs with { branch } and a job-board candidate (no Brave at all) is saved as a record end to end — the exact "Security" + "Zuid-Holland" scenario', async () => {
  const jobBoardProvider = fakeJobBoardProvider([{
    facts: {
      title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', salary: null, hours: null,
      contractType: null, description: 'A real vacancy description.', contactPerson: null, phone: null, email: 'jobs@acme-security.example',
    },
    sourceUrl: 'https://indeed.example/job/1', needsEnrichment: false,
  }]);
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security', region: 'Zuid-Holland', keywords: 'beveiliger security officer' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.searchQuery, 'Security beveiliger security officer Zuid-Holland');
    assert.ok(run.body.stats.sources.some(s => s.provider === 'ts-jobspy' && s.status === 'ok'));

    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body.length, 1);
    assert.equal(records.body[0].display_name, 'Security Officer');
  } finally { await close(); }
});

test('POST /projects/:id/runs requires either sourceUrl or branch — an empty body is rejected before touching the crawler, job board or search provider', async () => {
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

test('the existing { sourceUrl } website mode is byte-for-byte unchanged: same request shape, same response shape, still works with no searchProvider or jobBoardProvider configured at all', async () => {
  const pages = {
    '/': { body: '<html><head><title>T</title></head><body><a href="/vacatures/frontend-developer">x</a></body></html>' },
    '/vacatures/frontend-developer': { body: jobPostingPage('Frontend Developer', 'Acme Software', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' }); // no searchProvider, no jobBoardProvider
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme-software.example' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.searchMode, 'website');
  } finally { await close(); }
});

test('Brave blijft optioneel: a branch search with no BRAVE_SEARCH_API_KEY and no searchProvider still succeeds cleanly (0 records, never a failed run) when the job board itself has nothing either', async () => {
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key' }); // no searchProvider, default empty job board
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { branch: 'Security' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    assert.equal(run.body.recordsCreated, 0);
    assert.equal(run.body.stats.sources.find(s => s.provider === 'brave').status, 'not_configured');
  } finally { await close(); }
});
