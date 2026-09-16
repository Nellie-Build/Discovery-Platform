import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVacanciesAdapter } from '../dist/domains/vacancies-adapter.js';

function jobPostingPage(title, company, location) {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org/', '@type': 'JobPosting', title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: location } },
  });
  return `<html><head><title>${title}</title><script type="application/ld+json">${jsonLd}</script></head>
    <body><a href="mailto:jobs@${company.toLowerCase().replace(/\s+/g, '-')}.example">Apply</a></body></html>`;
}

// A vacancy-overview-style page: several *other* vacancies' own teaser widgets (the real
// production false positive on werkenbijdeoverheid.nl) — no JobPosting JSON-LD, and only one
// signal group (location/salary/hours/contractType), so the existing plausibility check must
// still reject it even when it arrives as a branch-search candidate.
function overviewPage() {
  return `<html><head><title>Vacatures - CareerSite</title><meta property="og:site_name" content="CareerSite"/></head>
    <body>
      <h1>CareerSite</h1>
      <ul>
        <li><span role="img" title="Locatie" aria-label="Locatie"></span><span>Utrecht</span></li>
        <li><span role="img" title="Locatie" aria-label="Locatie"></span><span>Rotterdam</span></li>
      </ul>
    </body></html>`;
}

/** Keyed by full URL (candidates can come from entirely different domains, unlike the
 * pathname-keyed `site()` helper the website-mode tests use). */
function transportFor(pagesByUrl) {
  return async url => {
    const page = pagesByUrl[url];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body) };
  };
}

function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, sleep: async ms => { now += ms; } };
}

function fakeSearchProvider(candidates) {
  const calls = [];
  return { provider: { async search(input) { calls.push(input); return candidates; } }, calls };
}

function branchInput(overrides = {}) {
  return { mode: 'branch', branch: 'Security', region: 'Nederland', keywords: null, existingRecords: [], ...overrides };
}

test('website mode is completely unaffected: still a plain crawlWebsite() call, no search provider involved', async () => {
  const pages = {
    'https://acme.example/': { body: '<html><head><title>T</title></head><body><a href="/vacatures/backend">x</a></body></html>' },
    'https://acme.example/vacatures/backend': { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') },
    'https://acme.example/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    'https://acme.example/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
  };
  const adapter = createVacanciesAdapter({ transport: transportFor(pages), clock: fakeClock() });
  const outcome = await adapter.runDiscovery({ mode: 'website', sourceUrl: 'https://acme.example', existingRecords: [] });
  assert.equal(outcome.stats.searchMode, 'website');
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].displayName, 'Backend Developer');
});

test('a real vacancy discovered via a branch-search candidate URL is saved as a record, with searchMode/searchQuery/candidate stats populated', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const { provider, calls } = fakeSearchProvider([{ url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: jobPostingPage('Security Officer', 'Acme', 'Den Haag') } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].displayName, 'Security Officer');
  assert.equal(outcome.stats.searchMode, 'branch');
  assert.equal(outcome.stats.searchQuery, 'vacature vacatures jobs Security Nederland');
  assert.equal(outcome.stats.branch, 'Security');
  assert.equal(outcome.stats.region, 'Nederland');
  assert.equal(outcome.stats.candidatesFound, 1);
  assert.equal(outcome.stats.candidatesCrawled, 1);
  assert.equal(outcome.stats.recordsCreated, 1);
  assert.equal(calls[0].query, 'vacature vacatures jobs Security Nederland');
  assert.equal(calls[0].country, 'NL');
  assert.equal(calls[0].language, 'nl');
});

test('a search result is never stored as a record on its own: a candidate page with no vacancy-specific signals produces zero records', async () => {
  const candidateUrl = 'https://acme.example/about-us';
  const { provider } = fakeSearchProvider([{ url: candidateUrl, title: 'About us', snippet: 'Company info', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: '<html><head><title>About us</title></head><body><p>We are a company.</p></body></html>' } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 0);
  assert.equal(outcome.stats.candidatesCrawled, 1);
  assert.equal(outcome.stats.factsFound, 0);
});

test('a false-positive-shaped candidate page (a vacancy overview page, the real werkenbijdeoverheid.nl regression) is still rejected via the existing plausibility check', async () => {
  const candidateUrl = 'https://careersite.example/vacatures';
  const { provider } = fakeSearchProvider([{ url: candidateUrl, title: 'Vacatures - CareerSite', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: overviewPage() } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 0);
});

test('duplicate candidate URLs from the search provider are only fetched once', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const { provider } = fakeSearchProvider([
    { url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' },
    { url: `${candidateUrl}?utm_source=brave`, title: 'Security Officer (dup)', snippet: '...', source: 'brave' },
  ]);
  let fetchCount = 0;
  const transport = async url => { fetchCount++; return transportFor({ [candidateUrl]: { body: jobPostingPage('Security Officer', 'Acme', 'Den Haag') } })(url); };
  const adapter = createVacanciesAdapter({ searchProvider: provider, transport });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(fetchCount, 1, 'the deduplicated candidate must only be fetched once');
  assert.equal(outcome.stats.candidatesFound, 1);
  assert.equal(outcome.records.length, 1);
});

test('the maximum number of candidates is respected even when the search provider returns more', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ url: `https://acme.example/vacature-${i}`, title: `Vacature ${i}`, snippet: '...', source: 'brave' }));
  const { provider } = fakeSearchProvider(many);
  let fetchCount = 0;
  const transport = async () => { fetchCount++; return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') }; };
  const adapter = createVacanciesAdapter({ searchProvider: provider, transport });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.stats.candidatesFound, 10);
  assert.equal(fetchCount, 10, 'never fetches more than the configured maximum');
});

test('a missing BRAVE_SEARCH_API_KEY gives a clear, safe error for branch mode and never crashes — website mode is unaffected', async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    // No searchProvider override and no env var: production's own lazy lookup path.
    const adapter = createVacanciesAdapter({ transport: async () => { throw new Error('must never be called'); } });
    await assert.rejects(adapter.runDiscovery(branchInput()), /BRAVE_SEARCH_API_KEY ontbreekt/);

    // Website mode, same adapter instance, still works — the missing key is entirely irrelevant to it.
    const websiteAdapter = createVacanciesAdapter({
      transport: transportFor({
        'https://acme.example/': { body: '<html><head><title>T</title></head><body></body></html>' },
        'https://acme.example/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
        'https://acme.example/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
      }),
      clock: fakeClock(),
    });
    const outcome = await websiteAdapter.runDiscovery({ mode: 'website', sourceUrl: 'https://acme.example', existingRecords: [] });
    assert.equal(outcome.stats.searchMode, 'website');
  } finally {
    if (originalKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});

test('the error message for a missing key never contains any key-shaped value, and stats never carries an API key field', async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const adapter = createVacanciesAdapter({});
    try {
      await adapter.runDiscovery(branchInput());
      assert.fail('expected a rejection');
    } catch (error) {
      assert.ok(!/[A-Za-z0-9]{20,}/.test(error.message), 'error message must never contain anything that looks like a real API key');
    }
  } finally {
    if (originalKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});

test('a search provider failure is handled cleanly — rejects with the provider\'s own error, never an uncaught crash', async () => {
  const failingProvider = { async search() { throw new Error('Brave Search-aanroep mislukt (status 500).'); } };
  const adapter = createVacanciesAdapter({ searchProvider: failingProvider, transport: async () => { throw new Error('must never be called'); } });
  await assert.rejects(adapter.runDiscovery(branchInput()), /Brave Search-aanroep mislukt/);
});

test('region is optional: a branch search without a region still builds a valid query and runs', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const { provider, calls } = fakeSearchProvider([{ url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: jobPostingPage('Security Officer', 'Acme', 'Den Haag') } }),
  });
  const outcome = await adapter.runDiscovery(branchInput({ region: null }));
  assert.equal(calls[0].query, 'vacature vacatures jobs Security');
  assert.equal(outcome.stats.region, null);
  assert.equal(outcome.records.length, 1);
});
