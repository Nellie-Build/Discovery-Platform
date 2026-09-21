import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractVacancyUrlIdentity, findVacancyDuplicates, rankVacancyCandidate, vacanciesCrawlerConfig } from '../dist/index.js';
import { CandidateQueue, createDiscoveryCrawler, crawlWebsite } from '@discovery-platform/core';

/**
 * One vacancy, many addresses: the same explicit job identifier under another language segment or alias
 * is the same vacancy. Vacancies decides what an identity is; discovery-core only treats equal opaque keys
 * as one thing to crawl. No language, host or site is known anywhere.
 */
const identity = url => extractVacancyUrlIdentity(url);
const rank = (url, source = 'link', label = '') => rankVacancyCandidate({ url, source, label, discoveredFrom: 'https://jobs.example/' });
const LANGS = ['nl', 'en', 'de', 'fr', 'se', 'no', 'dk', 'fi', 'pl', 'cn', 'ro', 'ny'];
const contactNormalizers = { normalizeEmail: () => null, normalizePhone: () => null };
const html = (links, title = 'T') => `<html><head><title>${title}</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
const jobUrl = (lang, id) => `/${lang}/what:job/jobID:${id}/`;
const spontaneousUrl = (lang, id) => `/${lang}/what:spontaneous/jobID:${id}/type:spontaneous/where:4/apply:1/`;

test('A: twelve language variants of one job ID share one identity; the fetchable URL is not rewritten', () => {
  const keys = new Set(LANGS.map(lang => identity(`https://jobs.example${jobUrl(lang, 966837)}`).key));
  assert.equal(keys.size, 1);
  const one = identity('https://jobs.example/en/what:job/jobID:966837/');
  assert.deepEqual({ type: one.type, value: one.value, origin: one.origin }, { type: 'jobid', value: '966837', origin: 'https://jobs.example' });
  assert.equal(one.namespace, 'what:job');
  assert.equal(one.key, 'https://jobs.example|what:job|jobid|966837');
  // The candidate keeps its real URL; only the key is shared.
  const ranks = LANGS.map(lang => rank(`https://jobs.example${jobUrl(lang, 966837)}`));
  assert.equal(new Set(ranks.map(r => r.dedupeKey)).size, 1);
  assert.ok(ranks.every(r => r.reasons.includes('job_identifier')));
});

test('B: different job IDs are different identities', () => {
  assert.notEqual(identity('https://jobs.example/nl/what:job/jobID:111/').key, identity('https://jobs.example/nl/what:job/jobID:222/').key);
});

test('C: the same job ID on another origin is not the same vacancy; a leading www. is not another origin', () => {
  assert.notEqual(identity('https://careers-a.example/x?jobId=123').key, identity('https://careers-b.example/x?jobId=123').key);
  assert.notEqual(identity('https://jobs.example/x?jobId=123').key, identity('http://jobs.example/x?jobId=123').key);
  assert.equal(identity('https://www.jobs.example/x?jobId=123').key, identity('https://jobs.example/y?jobId=123').key);
});

test('D: query-parameter identifiers (jobId, job_id, vacancyId, positionId, postingId) dedupe across path variants', () => {
  assert.equal(identity('https://jobs.example/en/jobs/view?jobId=12345').key, identity('https://jobs.example/de/jobs/view?jobId=12345').key);
  assert.equal(identity('https://jobs.example/a?job_id=77').key, identity('https://jobs.example/b?jobId=77').key, 'the key is compared without case or separators');
  assert.notEqual(identity('https://jobs.example/a?jobId=77').key, identity('https://jobs.example/a?vacancyId=77').key, 'a different identifier type is not assumed to be the same');
  for (const url of ['?vacancyId=a7F3', '?positionId=4411', '?postingID=778', '?requisition_id=R90']) assert.ok(identity(`https://jobs.example/x${url}`) !== null, url);
});

test('E: path identifiers (jobID:123) dedupe across path variants and ignore the surrounding segments', () => {
  assert.equal(identity('https://jobs.example/en/what:job/jobID:123/').key, identity('https://jobs.example/de/what:job/jobID:123/type:x/').key);
  assert.equal(identity('https://jobs.example/en/jobs/jobID:123').key, identity('https://jobs.example/de/jobs/jobID:123').key, 'a plain word before the identifier is not a namespace');
  assert.equal(identity('https://jobs.example/en/jobs/jobID:123').key, 'https://jobs.example|jobid|123');
  assert.equal(identity('https://jobs.example/nl/what:job/jobid=123').value, '123');
});

test('F: without an explicit identifier there is no identity: slug, title, language, page number and tracking never make one', () => {
  for (const url of ['https://jobs.example/vacatures/projectleider-123', 'https://jobs.example/o/senior-software-engineer', 'https://jobs.example/en/vacancies/12345',
    'https://jobs.example/vacatures?page=2', 'https://jobs.example/x?utm_campaign=123&ref=456', 'https://jobs.example/blog/jobid-tips', 'https://jobs.example/x?jobId=abc',
    'https://jobs.example/x?jobId=1', 'https://jobs.example/x?id=12345', 'https://jobs.example/about/jobidea1234', 'mailto:a@b.example', 'not a url']) {
    assert.equal(identity(url), null, url);
  }
  assert.equal(rank('https://jobs.example/o/senior-software-engineer').dedupeKey, undefined);
  assert.equal(rank('https://jobs.example/vacatures/projectleider').dedupeKey, undefined);
});

test('G: the same job ID with company=null is a duplicate record; other signals and other IDs are not affected', () => {
  const fact = (sourceUrl, extra = {}) => ({ title: 'Wmo consulent', company: null, location: null, salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null, sourceUrl, ...extra });
  const [dup] = findVacancyDuplicates([fact('https://jobs.example/en/what:job/jobID:966837/'), fact('https://jobs.example/de/what:job/jobID:966837/', { title: 'Wmo-consulent (DE)' })]);
  assert.equal(dup.decision, 'duplicate');
  assert.ok(dup.matchedSignals.includes('stableJobIdentity'));
  assert.deepEqual(findVacancyDuplicates([fact('https://jobs.example/en/what:job/jobID:1/'), fact('https://jobs.example/en/what:job/jobID:2/')]), []);
  assert.deepEqual(findVacancyDuplicates([fact('https://a.example/x?jobId=1'), fact('https://b.example/x?jobId=1')]), []);
  // The existing signals still work exactly as before.
  const same = findVacancyDuplicates([fact('https://jobs.example/vacatures/1'), fact('https://jobs.example/vacatures/1')]);
  assert.equal(same[0].decision, 'duplicate');
  assert.ok(same[0].matchedSignals.includes('sourceUrl'));
  const byCompany = findVacancyDuplicates([fact('https://jobs.example/a', { company: 'Acme', location: 'Delft' }), fact('https://jobs.example/b', { company: 'ACME', location: 'delft' })]);
  assert.ok(byCompany[0].matchedSignals.includes('companyTitleLocation'));
});

// ─── the queue keeps an identity, also after the first variant was taken ─────────────────────────

const candidate = (url, candidateScore) => ({ url, canonicalUrl: url, candidateScore, candidateReasons: [], classification: 'detail', source: 'link', label: '', discoveredFrom: '' });

test('queue: variants of one identity queue once; the better one waits, the earlier one on a tie', () => {
  const q = new CandidateQueue(10);
  assert.equal(q.offer(candidate('https://x/en/1', 50), 'k1'), true);
  assert.equal(q.offer(candidate('https://x/de/1', 50), 'k1'), false, 'tie: the first stays');
  assert.equal(q.offer(candidate('https://x/fr/1', 70), 'k1'), true, 'a better variant replaces it');
  assert.equal(q.offer(candidate('https://x/en/2', 40), 'k2'), true);
  assert.equal(q.size, 2);
  assert.equal(q.take(new Set()).url, 'https://x/fr/1');
  assert.equal(q.take(new Set()).url, 'https://x/en/2');
  assert.equal(q.take(new Set()), undefined);
});

test('J: once a variant is taken (in flight), a later-discovered variant is never queued', () => {
  const q = new CandidateQueue(10);
  q.offer(candidate('https://x/en/1', 50), 'k1');
  const taken = q.take(new Set());
  assert.equal(taken.url, 'https://x/en/1');
  assert.equal(q.offer(candidate('https://x/de/1', 99), 'k1'), false, 'the identity stays claimed after take()');
  assert.equal(q.size, 0);
  assert.equal(q.take(new Set()), undefined);
  // A URL without identity, and another identity, are unaffected.
  assert.equal(q.offer(candidate('https://x/plain', 5)), true);
  assert.equal(q.offer(candidate('https://x/en/2', 5), 'k2'), true);
});

test('queue: an evicted or replaced waiting variant does not leave a stale identity behind', () => {
  const q = new CandidateQueue(2);
  q.offer(candidate('https://x/a', 10), 'ka');
  q.offer(candidate('https://x/b', 20), 'kb');
  assert.equal(q.offer(candidate('https://x/c', 30), 'kc'), true, 'the full queue evicts the worst');
  assert.equal(q.offer(candidate('https://x/a2', 12), 'ka'), false, 'the queue is full and a2 is not better than the waiting ones');
  assert.equal(q.size, 2);
  assert.equal(q.take(new Set()).url, 'https://x/c');
  assert.equal(q.offer(candidate('https://x/a3', 40), 'ka'), true, 'ka was evicted unclaimed, so it can queue again');
});

// ─── open and spontaneous applications: lower crawl priority, still crawlable ────────────────────────

test('open applications keep their identifier but rank clearly lower; concrete vacancies are untouched', () => {
  const concrete = rank('https://jobs.example/nl/what:job/jobID:123/', 'listing');
  const spontaneous = rank('https://jobs.example/nl/what:spontaneous/jobID:123/type:spontaneous/where:4/apply:1/', 'listing');
  assert.ok(spontaneous.reasons.includes('job_identifier'));
  assert.ok(spontaneous.reasons.includes('open_application'));
  assert.ok(spontaneous.score + 40 <= concrete.score);
  assert.ok(spontaneous.dedupeKey, 'still deduplicated');
  assert.ok(spontaneous.score > -50, 'lower, never removed');
  assert.ok(rank('https://jobs.example/o/open-sollicitatie-bedrijf').reasons.includes('open_application'));
  assert.ok(rank('https://jobs.example/o/open-sollicitatie-bedrijf').score + 40 <= rank('https://jobs.example/o/senior-software-engineer').score);
  assert.ok(rank('https://jobs.example/careers/jobs/1', 'link', 'Open sollicitatie').reasons.includes('open_application'));
  for (const url of ['https://jobs.example/o/senior-software-engineer', 'https://jobs.example/o/stagevacature-bedrijf', 'https://jobs.example/o/vrijwilliger-bij-bedrijf',
    'https://jobs.example/o/trainee-software-engineer', 'https://jobs.example/o/internship-marketing-team', 'https://jobs.example/vacatures/opening-hours-manager']) {
    assert.ok(!rank(url).reasons.includes('open_application'), url);
  }
  assert.equal(rank('https://jobs.example/o/stagevacature-bedrijf', 'sitemap').classification, 'detail');
  assert.equal(rank('https://jobs.example/o/vrijwilliger-bij-bedrijf', 'sitemap').classification, 'detail');
});

// ─── end to end: a Varbi-shaped site through both crawl engines ───────────────────────────────────────

function varbiSite() {
  // One concrete job deliberately shares its number (4041) with an open application below.
  const ids = [4041, ...Array.from({ length: 9 }, (_, i) => 940007 + i * 7)];
  const spontaneous = [4041, 4701, 4802];
  const pages = { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' } };
  const homeLinks = [];
  for (const id of ids) for (const lang of LANGS) { homeLinks.push([jobUrl(lang, id), `Medewerker ${id}`]); pages[jobUrl(lang, id)] = { body: html([], `Vacature ${id} (${lang})`) }; }
  for (const id of spontaneous) for (const lang of ['nl', 'en']) { homeLinks.push([spontaneousUrl(lang, id), 'Spontaan']); pages[spontaneousUrl(lang, id)] = { body: html([], `Open ${id}`) }; }
  for (const lang of LANGS) homeLinks.push([`/${lang}/`, lang]);
  pages['/'] = { body: html(homeLinks, 'Start') };
  return { ids, spontaneous, pages };
}
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
const titleExtract = page => ({ title: page.$('title').first().text() || undefined });

for (const engine of ['legacy', 'crawlee']) {
  test(`[${engine}] Varbi-shaped: 10 jobs x 12 language variants are crawled once per job, open applications come later`, async () => {
    const { ids, spontaneous, pages } = varbiSite();
    const log = [];
    const crawler = createDiscoveryCrawler(engine, { maxConcurrency: 2 });
    const result = await crawler.crawl('https://jobs.example/', {
      ...vacanciesCrawlerConfig, contactNormalizers, extract: titleExtract, clock: fakeClock(), maxPages: 60, maxCandidates: 500,
      transport: async url => { const path = new URL(url).pathname; log.push(path); const page = pages[path]; return page ? { status: 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body) } : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }; },
    });
    const fetched = result.records.filter(r => r.kind === 'page' && r.attempted).map(r => new URL(r.url).pathname);
    const perJob = new Map();
    for (const path of fetched) { const m = /jobID:(\d+)\/(?!type)/.exec(path); if (m && /what:job/.test(path)) perJob.set(m[1], (perJob.get(m[1]) ?? 0) + 1); }
    assert.equal(perJob.size, ids.length, 'every job is still reached');
    assert.ok([...perJob.values()].every(count => count === 1), JSON.stringify([...perJob]));
    assert.equal(fetched.filter(path => /what:job/.test(path)).length, 10, 'at most one page per job identity');
    const perSpontaneous = new Set(fetched.filter(path => /spontaneous/.test(path)).map(path => /jobID:(\d+)/.exec(path)[1]));
    assert.ok(perSpontaneous.size <= spontaneous.length);
    assert.equal(fetched.filter(path => /spontaneous/.test(path)).length, perSpontaneous.size, 'not more than one page per open application either');
    // Discovery still shows what the site publishes: 120 job URLs + 6 open-application URLs + 12 language homes + the start page.
    const stats = result.discoveryStats;
    assert.equal(stats.uniqueUrlsDiscovered, 120 + 6 + 12 + 1);
    assert.equal(stats.uniqueCrawlIdentities, 10 + 3 + 12 + 1);
    assert.equal(stats.candidateIdentityDuplicates, 110 + 3);
    assert.equal(stats.candidateUrlsFound, stats.uniqueUrlsDiscovered);
    assert.ok(stats.candidatesProcessed <= stats.uniqueCrawlIdentities);
    if (engine === 'legacy') {
      const lastJob = Math.max(...fetched.map((path, i) => /what:job/.test(path) ? i : -1));
      const firstSpontaneous = fetched.findIndex(path => /spontaneous/.test(path));
      assert.ok(firstSpontaneous === -1 || firstSpontaneous > lastJob, 'open applications after every concrete vacancy');
    }
  });
}

test('I: a requested job URL is fetched first, and a later-discovered language variant is not fetched again', async () => {
  const { pages } = varbiSite();
  const requested = jobUrl('en', 940007);
  const log = [];
  const result = await crawlWebsite(`https://jobs.example${requested}`, {
    ...vacanciesCrawlerConfig, contactNormalizers, extract: titleExtract, clock: fakeClock(), maxPages: 60,
    transport: async url => { const path = new URL(url).pathname; log.push(path); const page = pages[path] ?? (path === requested ? { body: html([[jobUrl('de', 940007), 'variant'], ['/', 'home']]) } : null); return page ? { status: 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body) } : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }; },
  });
  const fetched = result.records.filter(r => r.kind === 'page' && r.attempted).map(r => new URL(r.url).pathname);
  assert.equal(fetched[0], requested);
  assert.equal(fetched.filter(path => path.includes('jobID:940007/') && path.includes('what:job')).length, 1);
});

test('without a ranking that supplies keys, the crawler behaves as before (only canonical URLs dedupe)', async () => {
  const pages = { '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }, '/': { body: html([['/en/a', 'a'], ['/de/a', 'a']]) }, '/en/a': { body: html([]) }, '/de/a': { body: html([]) } };
  const result = await crawlWebsite('https://jobs.example/', {
    contactNormalizers, extract: titleExtract, clock: fakeClock(),
    transport: async url => { const page = pages[new URL(url).pathname]; return page ? { status: 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body) } : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') }; },
  });
  assert.equal(result.records.filter(r => r.kind === 'page' && r.attempted).length, 3);
  assert.equal(result.discoveryStats.candidateIdentityDuplicates, 0);
  assert.equal(result.discoveryStats.uniqueCrawlIdentities, result.discoveryStats.uniqueUrlsDiscovered);
});

// ─── namespaces: the same number in two explicit record families is two identities ─────────────────

test('N1: what:job/jobID:4041 and what:spontaneous/jobID:4041 are different identities, in every language', () => {
  const job = LANGS.map(lang => identity(`https://jobs.example/${lang}/what:job/jobID:4041/`).key);
  const open = LANGS.map(lang => identity(`https://jobs.example/${lang}/what:spontaneous/jobID:4041/type:spontaneous/where:4/apply:1/`).key);
  assert.equal(new Set(job).size, 1);
  assert.equal(new Set(open).size, 1);
  assert.notEqual(job[0], open[0]);
  assert.equal(job[0], 'https://jobs.example|what:job|jobid|4041');
  assert.equal(open[0], 'https://jobs.example|what:spontaneous|jobid|4041');
});

test('N2: the locale is never a namespace; only an explicit key:value family segment directly before the identifier is', () => {
  for (const before of ['en', 'de', 'nl-NL', 'jobs', 'vacatures', 'campaign', 'utm_source', 'categorie-zorg']) {
    assert.equal(identity(`https://jobs.example/${before}/jobID:12`)?.namespace ?? null, null, before);
  }
  assert.equal(identity('https://jobs.example/what:job/en/jobID:12').namespace, null, 'the family must directly precede the identifier');
  assert.equal(identity('https://jobs.example/where:62/what:job/jobID:12').namespace, 'what:job', 'only the directly preceding segment');
  assert.equal(identity('https://jobs.example/en/what:job/jobID:12').key, identity('https://jobs.example/de/where:9/what:job/jobID:12').key);
  assert.equal(identity('https://jobs.example/what:job/jobID:12/what:x/jobID:23').value, '12', 'the first identifier wins');
});

test('N3: query identities keep working and ignore other parameters', () => {
  assert.equal(identity('https://jobs.example/vacature?jobId=123').key, identity('https://jobs.example/vacature?jobId=123&lang=en').key);
  assert.equal(identity('https://jobs.example/vacature?jobId=123').key, 'https://jobs.example|jobid|123');
  assert.equal(identity('https://jobs.example/en/vacature?jobId=123').key, identity('https://jobs.example/de/vacature?jobId=123').key);
});

test('N4: record level — job 4041 is not a duplicate of spontaneous 4041, but is of its own language variant', () => {
  const fact = (sourceUrl, title) => ({ title, company: null, location: null, salary: null, hours: null, contractType: null, description: null, contactPerson: null, phone: null, email: null, sourceUrl });
  assert.deepEqual(findVacancyDuplicates([fact('https://jobs.example/en/what:job/jobID:4041/', 'Wmo consulent'), fact('https://jobs.example/en/what:spontaneous/jobID:4041/', 'Open sollicitatie')]), []);
  const same = findVacancyDuplicates([fact('https://jobs.example/en/what:job/jobID:4041/', 'A'), fact('https://jobs.example/de/what:job/jobID:4041/', 'B')]);
  assert.equal(same[0].decision, 'duplicate');
  const open = findVacancyDuplicates([fact('https://jobs.example/en/what:spontaneous/jobID:4041/', 'A'), fact('https://jobs.example/de/what:spontaneous/jobID:4041/', 'B')]);
  assert.equal(open[0].decision, 'duplicate');
  assert.deepEqual(findVacancyDuplicates([fact('https://a.example/en/what:job/jobID:4041/', 'A'), fact('https://b.example/en/what:job/jobID:4041/', 'B')]), []);
});

test('N5: queue level — the two families with one number are two crawl identities', () => {
  const q = new CandidateQueue(10);
  const key = url => rank(url).dedupeKey;
  assert.equal(q.offer(candidate('https://jobs.example/en/what:job/jobID:4041/', 65), key('https://jobs.example/en/what:job/jobID:4041/')), true);
  assert.equal(q.offer(candidate('https://jobs.example/en/what:spontaneous/jobID:4041/', 15), key('https://jobs.example/en/what:spontaneous/jobID:4041/')), true);
  assert.equal(q.offer(candidate('https://jobs.example/de/what:job/jobID:4041/', 65), key('https://jobs.example/de/what:job/jobID:4041/')), false);
  assert.equal(q.offer(candidate('https://jobs.example/de/what:spontaneous/jobID:4041/', 15), key('https://jobs.example/de/what:spontaneous/jobID:4041/')), false);
  assert.equal(q.size, 2);
});
