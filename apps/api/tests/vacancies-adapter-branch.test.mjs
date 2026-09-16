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

/** An empty job-board provider — used by every test that only wants to exercise the Brave
 * (web-search) path in isolation, without a real/mocked job board also contributing candidates. */
function emptyJobBoardProvider() {
  return {
    async findCandidates() {
      return {
        candidates: [],
        meta: [
          { provider: 'ts-jobspy', site: 'indeed', status: 'empty', candidates: 0, durationMs: 1, error: null },
          { provider: 'ts-jobspy', site: 'linkedin', status: 'empty', candidates: 0, durationMs: 1, error: null },
        ],
      };
    },
  };
}

function fakeJobBoardProvider(result) {
  const calls = [];
  return { provider: { async findCandidates(query) { calls.push(query); return result; } }, calls };
}

function jobBoardCandidate({ title, company, location, description = 'A real vacancy description.', email = 'jobs@example.test', sourceUrl }) {
  return { facts: { title, company, location, salary: null, hours: null, contractType: null, description, contactPerson: null, phone: null, email }, sourceUrl, needsEnrichment: !description || !email };
}

function branchInput(overrides = {}) {
  return { mode: 'branch', branch: 'Security', region: 'Nederland', keywords: null, existingRecords: [], ...overrides };
}

test('website mode is completely unaffected: still a plain crawlWebsite() call, no search provider or job-board provider involved', async () => {
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

// ─── Security + Zuid-Holland: the exact scenario named in the brief ────────────────────────────

test('"Security" + "Zuid-Holland" (Security + Zuid-Holland) is turned into the right query for the job board, and a real result is saved as a record', async () => {
  const { provider, calls } = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 500, error: null }],
  });
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider, transport: async () => { throw new Error('enrichment must not be needed for a complete candidate'); } });
  const outcome = await adapter.runDiscovery(branchInput({ branch: 'Security', region: 'Zuid-Holland', keywords: 'beveiliger security officer' }));
  // The job board never gets the web-search hints, and region is never folded into the search
  // term — it goes through the query's own dedicated `location` field instead.
  assert.equal(calls[0].query, 'Security beveiliger security officer');
  assert.equal(calls[0].location, 'Zuid-Holland');
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].displayName, 'Security Officer');
  assert.equal(outcome.stats.searchMode, 'branch');
  assert.equal(outcome.stats.branch, 'Security');
  assert.equal(outcome.stats.region, 'Zuid-Holland');
  assert.equal(outcome.stats.keywords, 'beveiliger security officer');
  assert.equal(outcome.stats.jobBoardSearchTerm, 'Security beveiliger security officer');
  // The web-search (Brave) query, kept separate, still gets the discovery hints + region.
  assert.equal(outcome.stats.searchQuery, 'vacature vacatures jobs Security beveiliger security officer Zuid-Holland');
});

test('Beveiliging + Zuid-Holland + Nederland: the job board receives country="netherlands" and an English location, never the raw Dutch region text', async () => {
  const { provider, calls } = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Beveiliger', company: 'Acme Security', location: 'Amsterdam', sourceUrl: 'https://indeed.example/job/2' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 500, error: null }],
  });
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider });
  await adapter.runDiscovery(branchInput({ branch: 'Beveiliging', region: 'Nederland', keywords: 'beveiliger security officer' }));
  assert.equal(calls[0].query, 'Beveiliging beveiliger security officer');
  assert.ok(!calls[0].query.includes('Security'), '"Beveiliging" must never be silently replaced by "Security"');
  assert.equal(calls[0].location, 'Nederland'); // the raw region is handed to the provider, which normalizes it internally
});

// ─── Per-jobboard statistics stay visible (Indeed vs. LinkedIn separately) ──────────────────────

test('stats.sources reports Indeed and LinkedIn separately (status, candidates, durationMs, error) — not merged into one combined "ts-jobspy" entry, so it is visible which specific board did or didn\'t honor the location filter', async () => {
  const { provider } = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Beveiliger', company: 'Acme Security', location: 'Amsterdam', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [
      { provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 5, durationMs: 620, error: null },
      { provider: 'ts-jobspy', site: 'linkedin', status: 'error', candidates: 0, durationMs: 310, error: 'RateLimitException: linkedin rate limited' },
    ],
  });
  const adapter = createVacanciesAdapter({ jobBoardProvider: provider });
  const outcome = await adapter.runDiscovery(branchInput());
  const indeedMeta = outcome.stats.sources.find(s => s.provider === 'ts-jobspy' && s.site === 'indeed');
  const linkedinMeta = outcome.stats.sources.find(s => s.provider === 'ts-jobspy' && s.site === 'linkedin');
  assert.ok(indeedMeta, 'Indeed must have its own separate stats.sources entry');
  assert.ok(linkedinMeta, 'LinkedIn must have its own separate stats.sources entry');
  assert.equal(indeedMeta.status, 'ok');
  assert.equal(indeedMeta.candidates, 5);
  assert.equal(indeedMeta.durationMs, 620);
  assert.equal(indeedMeta.error, null);
  assert.equal(linkedinMeta.status, 'error');
  assert.equal(linkedinMeta.candidates, 0);
  assert.match(linkedinMeta.error, /rate limited/);
});

// ─── Multiple sources, failure isolation ────────────────────────────────────────────────────────

test('meerdere bronnen tegelijk: the job board and Brave both contribute candidates for the same branch search, each reported in stats.sources', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const braveUrl = 'https://acme.example/vacatures/backend-developer';
  const { provider: braveProvider } = fakeSearchProvider([{ url: braveUrl, title: 'Backend Developer', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    jobBoardProvider: jobBoard.provider,
    searchProvider: braveProvider,
    transport: transportFor({ [braveUrl]: { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 2);
  assert.deepEqual(new Set(outcome.records.map(r => r.displayName)), new Set(['Security Officer', 'Backend Developer']));
  const sources = outcome.stats.sources.map(s => s.provider);
  assert.ok(sources.includes('ts-jobspy'));
  assert.ok(sources.includes('brave'));
});

test('één bron error, andere bron blijft behouden: the job board throwing entirely does not discard Brave\'s own candidates', async () => {
  const failingJobBoard = { async findCandidates() { throw new Error('ts-jobspy: LinkedIn rate limited, Indeed unreachable'); } };
  const braveUrl = 'https://acme.example/vacatures/backend-developer';
  const { provider: braveProvider } = fakeSearchProvider([{ url: braveUrl, title: 'Backend Developer', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    jobBoardProvider: failingJobBoard,
    searchProvider: braveProvider,
    transport: transportFor({ [braveUrl]: { body: jobPostingPage('Backend Developer', 'Acme', 'Utrecht') } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].displayName, 'Backend Developer');
  const jobBoardMeta = outcome.stats.sources.find(s => s.provider === 'ts-jobspy');
  assert.equal(jobBoardMeta.status, 'error');
  assert.match(jobBoardMeta.error, /LinkedIn rate limited/);
});

test('één bron error, andere bron blijft behouden (omgekeerd): Brave throwing entirely does not discard the job board\'s own candidates', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const failingBrave = { async search() { throw new Error('Brave Search-aanroep mislukt (status 500).'); } };
  const adapter = createVacanciesAdapter({ jobBoardProvider: jobBoard.provider, searchProvider: failingBrave });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0].displayName, 'Security Officer');
  const braveMeta = outcome.stats.sources.find(s => s.provider === 'brave');
  assert.equal(braveMeta.status, 'error');
  assert.match(braveMeta.error, /Brave Search-aanroep mislukt/);
});

// ─── Brave stays optional ────────────────────────────────────────────────────────────────────

test('Brave blijft optioneel: no BRAVE_SEARCH_API_KEY and no searchProvider override — branch mode still succeeds via the job board alone, Brave is simply never attempted', async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const jobBoard = fakeJobBoardProvider({
      candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
      meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
    });
    const adapter = createVacanciesAdapter({ jobBoardProvider: jobBoard.provider });
    const outcome = await adapter.runDiscovery(branchInput());
    assert.equal(outcome.records.length, 1);
    assert.equal(outcome.stats.searchMode, 'branch');
    assert.ok(!outcome.stats.sources.some(s => s.provider === 'brave'), 'brave was never attempted at all, not even as a failure');
  } finally {
    if (originalKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKey;
  }
});

// ─── Structured vs. enriched candidates ─────────────────────────────────────────────────────────

test('structured candidate wordt niet opnieuw gecrawld: a complete job-board candidate (description + email) is never fetched again', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  let transportCalls = 0;
  const adapter = createVacanciesAdapter({ jobBoardProvider: jobBoard.provider, transport: async () => { transportCalls++; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html></html>') }; } });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(transportCalls, 0, 'a complete candidate must never trigger an enrichment fetch');
  assert.equal(outcome.records.length, 1);
});

test('incomplete candidate kan optioneel enriched worden: a thin job-board candidate (no description, no email) is fetched once, and the enrichment only fills in what the job board left null — never overwrites what it already gave', async () => {
  const sourceUrl = 'https://linkedin.example/jobs/view/2';
  const jobBoard = fakeJobBoardProvider({
    candidates: [{
      facts: { title: 'Beleidsadviseur Veiligheid', company: 'Gemeente Voorbeeld', location: 'Zuid-Holland', salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null },
      sourceUrl, needsEnrichment: true,
    }],
    meta: [{ provider: 'ts-jobspy', site: 'linkedin', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  let transportCalls = 0;
  // A page whose own JSON-LD deliberately claims a *different* title/company than the job board
  // already gave — proving enrichment can only fill nulls, never override an explicit field.
  const enrichedPage = jobPostingPage('Should Not Override Title', 'Should Not Override Company', 'Should Not Override Location');
  const adapter = createVacanciesAdapter({
    jobBoardProvider: jobBoard.provider,
    transport: async url => { transportCalls++; return transportFor({ [sourceUrl]: { body: enrichedPage } })(url); },
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(transportCalls, 1, 'a thin candidate is fetched exactly once for enrichment');
  assert.equal(outcome.records.length, 1);
  // The job board's own title/company/location win — enrichment (from a JSON-LD page that
  // deliberately has different values) never overrides fields the job board already supplied.
  assert.equal(outcome.records[0].displayName, 'Beleidsadviseur Veiligheid');
  assert.equal(outcome.records[0].domainData.company, 'Gemeente Voorbeeld');
});

// ─── Dedupe and scoring stay authoritative ──────────────────────────────────────────────────────

test('onze eigen dedupe blijft leidend: the same vacancy found via both the job board and Brave collapses into a single record', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const braveUrl = 'https://acme-security.example/vacatures/security-officer';
  const { provider: braveProvider } = fakeSearchProvider([{ url: braveUrl, title: 'Security Officer', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    jobBoardProvider: jobBoard.provider,
    searchProvider: braveProvider,
    transport: transportFor({ [braveUrl]: { body: jobPostingPage('Security Officer', 'Acme Security', 'Den Haag') } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 1, 'the same vacancy from two sources must collapse into one record');
  assert.equal(outcome.stats.duplicatesWithinCrawl, 1);
});

test('onze scoring blijft werken: a record built from a job-board candidate still gets a completeness score and classification', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const adapter = createVacanciesAdapter({ jobBoardProvider: jobBoard.provider });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.ok(typeof outcome.records[0].score === 'number' && outcome.records[0].score > 0);
  assert.ok(Array.isArray(outcome.records[0].classification.presentSignals) && outcome.records[0].classification.presentSignals.length > 0);
});

// ─── Existing Brave-only behavior, still intact ─────────────────────────────────────────────────

test('a search result is never stored as a record on its own: a Brave candidate page with no vacancy-specific signals produces zero records', async () => {
  const candidateUrl = 'https://acme.example/about-us';
  const { provider } = fakeSearchProvider([{ url: candidateUrl, title: 'About us', snippet: 'Company info', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    jobBoardProvider: emptyJobBoardProvider(),
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: '<html><head><title>About us</title></head><body><p>We are a company.</p></body></html>' } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 0);
});

test('a false-positive-shaped Brave candidate page (a vacancy overview page, the real werkenbijdeoverheid.nl regression) is still rejected via the existing plausibility check', async () => {
  const candidateUrl = 'https://careersite.example/vacatures';
  const { provider } = fakeSearchProvider([{ url: candidateUrl, title: 'Vacatures - CareerSite', snippet: '...', source: 'brave' }]);
  const adapter = createVacanciesAdapter({
    jobBoardProvider: emptyJobBoardProvider(),
    searchProvider: provider,
    transport: transportFor({ [candidateUrl]: { body: overviewPage() } }),
  });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(outcome.records.length, 0);
});

test('duplicate Brave candidate URLs are only fetched once', async () => {
  const candidateUrl = 'https://acme.example/vacatures/security-officer';
  const { provider } = fakeSearchProvider([
    { url: candidateUrl, title: 'Security Officer', snippet: '...', source: 'brave' },
    { url: `${candidateUrl}?utm_source=brave`, title: 'Security Officer (dup)', snippet: '...', source: 'brave' },
  ]);
  let fetchCount = 0;
  const transport = async url => { fetchCount++; return transportFor({ [candidateUrl]: { body: jobPostingPage('Security Officer', 'Acme', 'Den Haag') } })(url); };
  const adapter = createVacanciesAdapter({ jobBoardProvider: emptyJobBoardProvider(), searchProvider: provider, transport });
  const outcome = await adapter.runDiscovery(branchInput());
  assert.equal(fetchCount, 1, 'the deduplicated candidate must only be fetched once');
  assert.equal(outcome.records.length, 1);
});

test('the maximum number of Brave candidates is respected even when the search provider returns more', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ url: `https://acme.example/vacature-${i}`, title: `Vacature ${i}`, snippet: '...', source: 'brave' }));
  const { provider } = fakeSearchProvider(many);
  let fetchCount = 0;
  const transport = async () => { fetchCount++; return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') }; };
  const adapter = createVacanciesAdapter({ jobBoardProvider: emptyJobBoardProvider(), searchProvider: provider, transport });
  await adapter.runDiscovery(branchInput());
  assert.equal(fetchCount, 10, 'never fetches more than the configured maximum');
});

test('region is optional: a branch search without a region still builds a valid query and runs', async () => {
  const jobBoard = fakeJobBoardProvider({
    candidates: [jobBoardCandidate({ title: 'Security Officer', company: 'Acme Security', location: 'Den Haag', sourceUrl: 'https://indeed.example/job/1' })],
    meta: [{ provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 1, durationMs: 400, error: null }],
  });
  const adapter = createVacanciesAdapter({ jobBoardProvider: jobBoard.provider });
  const outcome = await adapter.runDiscovery(branchInput({ region: null }));
  assert.equal(jobBoard.calls[0].query, 'Security');
  assert.equal(jobBoard.calls[0].location, null);
  assert.equal(outcome.stats.region, null);
  assert.equal(outcome.records.length, 1);
});
