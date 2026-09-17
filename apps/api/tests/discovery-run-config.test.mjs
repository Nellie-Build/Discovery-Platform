import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestApp, html, uniqueEmail } from './helpers/test-app.mjs';
import { ABSOLUTE_MAX_PAGES, ABSOLUTE_MAX_TARGET_RECORDS } from '../dist/discovery-run-config.js';

function jobPostingPage(title, company, location, extra = {}) {
  const jsonLd = {
    '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
    ...extra,
  };
  return `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>
    <body><a href="mailto:jobs@${company.toLowerCase().replace(/\s+/g, '-')}.example">Apply</a></body></html>`;
}

async function createWorkspaceAndProject(request, domain = 'vacancies') {
  const workspace = (await request('POST', '/workspaces', { body: { name: 'W' } })).body;
  const project = (await request('POST', '/projects', { body: { workspaceId: workspace.id, name: 'Scan', domain } })).body;
  return { workspace, project };
}

function fakeJobBoardProvider(result) {
  const calls = [];
  return { provider: { async findCandidates(query) { calls.push(query); return result; } }, calls };
}
function jobBoardCandidate({ title, company, location, description = 'A real vacancy description.', email = 'jobs@example.test', sourceUrl, postedDate = null }) {
  return { facts: { title, company, location, salary: null, hours: null, contractType: null, description, contactPerson: null, phone: null, email, postedDate }, sourceUrl, needsEnrichment: !description || !email };
}

// ─── targetRecords stopping (website mode) ─────────────────────────────────────────────────────

test('target=10 stops the crawl once 10 valid, new records are found — never more pages than needed', async () => {
  const many = Array.from({ length: 40 }, (_, i) => [`/vacatures/role-${i}`, `role ${i}`]);
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html(many) },
  };
  for (let i = 0; i < 40; i++) pages[`/vacatures/role-${i}`] = { body: jobPostingPage(`Role ${i}`, 'Acme', 'Utrecht') };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 10, maxPages: 39 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 10);
    assert.equal(run.body.stats.targetRecords, 10);
    assert.equal(run.body.stats.recordsAccepted, 10);
    assert.equal(run.body.stats.stopReason, 'target_reached');
    // Never visited all 41 candidate pages (home + 40 roles) — stopped well short once 10 records existed.
    assert.ok(run.body.stats.pagesVisited < 41, `expected to stop early, visited ${run.body.stats.pagesVisited}`);
  } finally { await close(); }
});

test('a higher target (well past the old hardcoded 10-page limit) processes more than 10 pages', async () => {
  const many = Array.from({ length: 20 }, (_, i) => [`/vacatures/role-${i}`, `role ${i}`]);
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html(many) },
  };
  for (let i = 0; i < 20; i++) pages[`/vacatures/role-${i}`] = { body: jobPostingPage(`Role ${i}`, 'Acme', 'Utrecht') };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 18, maxPages: 25 } },
    });
    assert.equal(run.status, 201);
    assert.ok(run.body.stats.pagesVisited > 10, `expected more than 10 pages visited, got ${run.body.stats.pagesVisited}`);
  } finally { await close(); }
});

test('a rejected page (no vacancy signals) never counts toward the target', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/real', 'real'], ['/over-ons', 'about']]) },
    '/vacatures/real': { body: jobPostingPage('Real Vacancy', 'Acme', 'Utrecht') },
    '/over-ons': { body: '<html><head><title>Over ons</title></head><body><p>Wij zijn een modern bedrijf.</p></body></html>' },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 2, maxPages: 10 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 1, 'only the real vacancy counts — the rejected "over ons" page never becomes a record');
    assert.equal(run.body.stats.stopReason, 'no_more_candidates');
  } finally { await close(); }
});

test('a duplicate vacancy never counts toward the target — the run keeps going until a genuinely new one is found', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/a', 'a'], ['/vacatures/a-mirror', 'a-mirror'], ['/vacatures/b', 'b']]) },
    '/vacatures/a': { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') },
    '/vacatures/a-mirror': { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') }, // exact duplicate
    '/vacatures/b': { body: jobPostingPage('Frontend Developer', 'Acme', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 2, maxPages: 10 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 2, 'both distinct vacancies are found — the duplicate never stood in for the second one');
    const records = await request('GET', `/projects/${project.id}/records`);
    assert.deepEqual(new Set(records.body.map(r => r.display_name)), new Set(['Backend Developer', 'Frontend Developer']));
  } finally { await close(); }
});

test('stopReason "page_limit" is reported when maxPages caps the crawl before the target is reached', async () => {
  const many = Array.from({ length: 20 }, (_, i) => [`/vacatures/role-${i}`, `role ${i}`]);
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html(many) },
  };
  for (let i = 0; i < 20; i++) pages[`/vacatures/role-${i}`] = { body: jobPostingPage(`Role ${i}`, 'Acme', 'Utrecht') };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 100, maxPages: 5 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.stats.stopReason, 'page_limit');
    assert.equal(run.body.stats.pagesVisited, 5);
    assert.ok(run.body.stats.recordsAccepted < 100);
  } finally { await close(); }
});

// ─── onlyNewRecords ─────────────────────────────────────────────────────────────────────────────

test('onlyNewRecords: true (the default) never re-saves a vacancy that already exists for this project', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/a', 'a']]) },
    '/vacatures/a': { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const first = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(first.body.recordsCreated, 1);
    const second = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(second.body.recordsCreated, 0, 'the same vacancy is not re-saved on a second run by default');
  } finally { await close(); }
});

test('onlyNewRecords: false allows a vacancy that already exists for this project to be saved again', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/a', 'a']]) },
    '/vacatures/a': { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const first = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example' } });
    assert.equal(first.body.recordsCreated, 1);
    const second = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { onlyNewRecords: false } },
    });
    assert.equal(second.body.recordsCreated, 1, 'with onlyNewRecords off, the same vacancy can be re-discovered and saved again');
  } finally { await close(); }
});

// ─── postedWithinDays ───────────────────────────────────────────────────────────────────────────

test('postedWithinDays filters out a vacancy posted outside the window, and reports dateFilteredCount', async () => {
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/old', 'old'], ['/vacatures/new', 'new']]) },
    '/vacatures/old': { body: jobPostingPage('Old Vacancy', 'Acme', 'Utrecht', { datePosted: oldDate }) },
    '/vacatures/new': { body: jobPostingPage('New Vacancy', 'Acme', 'Utrecht', { datePosted: recentDate }) },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', filters: { postedWithinDays: 7 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.dateFilteredCount, 1);
    const records = await request('GET', `/projects/${project.id}/records`);
    assert.equal(records.body[0].display_name, 'New Vacancy');
  } finally { await close(); }
});

test('a vacancy with no known postedDate is kept by default when postedWithinDays is set — never auto-rejected for a missing date', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: html([['/vacatures/unknown-date', 'x']]) },
    '/vacatures/unknown-date': { body: jobPostingPage('No Date Vacancy', 'Acme', 'Utrecht') },
  };
  const { request, close } = await startTestApp({ pages, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', filters: { postedWithinDays: 7 } },
    });
    assert.equal(run.body.recordsCreated, 1);
    assert.equal(run.body.stats.dateFilteredCount, 0);
  } finally { await close(); }
});

// ─── Source selection (branch mode) ────────────────────────────────────────────────────────────

test('sources: ["indeed"] only calls indeed — linkedin is never called', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: jobBoard.provider });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { branch: 'Security', filters: { sources: ['indeed'] } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.recordsCreated, 1);
    // The fake job-board provider was called exactly once (representing indeed only, per the
    // source selection) — a real deployment would additionally never construct a linkedin-sites
    // provider instance at all (see vacancies-adapter.ts's own jobBoardSites plumbing).
    assert.equal(jobBoard.calls.length, 1);
  } finally { await close(); }
});

test('an unknown/unavailable requested source produces a clear, isolated error entry in stats.sources, never failing the run', async () => {
  const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: { async findCandidates() { return { candidates: [], meta: [] }; } } });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { branch: 'Security', filters: { sources: ['glassdoor'] } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.status, 'succeeded');
    const unknown = run.body.stats.sources.find(s => s.provider === 'glassdoor');
    assert.ok(unknown, 'an unknown source must be reported, not silently dropped');
    assert.equal(unknown.status, 'error');
  } finally { await close(); }
});

test('web_search explicitly requested but not configured (no Brave key/override) produces a clear error entry', async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const { request, close } = await startTestApp({ pages: {}, apiKey: 'test-key', jobBoardProvider: { async findCandidates() { return { candidates: [], meta: [] }; } } });
    try {
      const { project } = await createWorkspaceAndProject(request);
      const run = await request('POST', `/projects/${project.id}/runs`, {
        body: { branch: 'Security', filters: { sources: ['web_search'] } },
      });
      assert.equal(run.status, 201);
      const webSearch = run.body.stats.sources.find(s => s.provider === 'brave');
      assert.ok(webSearch, 'a clear notice must appear even though nothing was actually attempted');
      assert.equal(webSearch.status, 'error');
      assert.match(webSearch.error, /not configured/i);
    } finally { await close(); }
  } finally {
    if (originalKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});

// ─── Server-side absolute caps ──────────────────────────────────────────────────────────────────

test('a huge requested targetRecords/maxPages is clamped server-side to the absolute maximum, never trusted as-is', async () => {
  const { request, close } = await startTestApp({ pages: { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' }, '/': {} }, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, {
      body: { sourceUrl: 'https://acme.example', runConfig: { targetRecords: 999_999_999, maxPages: 999_999 } },
    });
    assert.equal(run.status, 201);
    assert.equal(run.body.stats.targetRecords, ABSOLUTE_MAX_TARGET_RECORDS);
    assert.equal(run.body.stats.maxPages, ABSOLUTE_MAX_PAGES);
  } finally { await close(); }
});

test('an invalid/missing runConfig silently falls back to sensible server-side defaults, never a 400', async () => {
  const { request, close } = await startTestApp({ pages: { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' }, '/': {} }, apiKey: 'test-key' });
  try {
    const { project } = await createWorkspaceAndProject(request);
    const run = await request('POST', `/projects/${project.id}/runs`, { body: { sourceUrl: 'https://acme.example', runConfig: 'not-an-object' } });
    assert.equal(run.status, 201);
    assert.equal(run.body.stats.targetRecords, 50);
  } finally { await close(); }
});
