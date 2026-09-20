import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankVacancyCandidate, vacanciesCrawlerConfig } from '../dist/index.js';
import { extractVacancy } from '../dist/extract-vacancy.js';
import { crawlWebsite } from '@discovery-platform/core';

/**
 * Detail-URL recognition beyond the classic "/vacatures/<slug>": structural signals only (an explicit
 * job identifier, a record route with an id, a one-letter route with a descriptive slug), never a
 * hostname. The shapes below reproduce what real applicant-tracking sites publish, with invented hosts.
 */
const rank = (path, source = 'link', label = '') => rankVacancyCandidate({ url: `https://jobs.example${path}`, source, label, discoveredFrom: 'https://jobs.example/' });
const contactNormalizers = { normalizeEmail: () => null, normalizePhone: () => null };
function fakeSite(pages, requests = []) {
  let now = 0;
  return {
    ...vacanciesCrawlerConfig, contactNormalizers,
    clock: { now: () => now, sleep: async ms => { now += ms; } },
    transport: async url => {
      const { pathname } = new URL(url);
      requests.push(pathname);
      const page = pages[pathname];
      if (page === undefined && pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /') };
      if (page === undefined) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') };
      if (page.redirect) return { status: 301, headers: { location: page.redirect }, body: Buffer.from('') };
      return { status: 200, headers: page.headers ?? { 'content-type': pathname.endsWith('.xml') ? 'application/xml' : pathname === '/robots.txt' ? 'text/plain' : 'text/html' }, body: Buffer.from(page.body ?? page) };
    },
  };
}
const links = list => `<html><head><title>Start</title></head><body>${list.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
const urlset = urls => `<urlset>${urls.map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const posting = (title, org = 'Acme Zorg') => `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, description: `<p>${title}: een afwisselende functie binnen ${org}. Je werkt in een team, begeleidt cliënten en draagt bij aan goede zorg voor iedereen.</p>`,
  hiringOrganization: { '@type': 'Organization', name: org },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Delft' } } })}</script></head><body><h1>${title}</h1></body></html>`;
const paths = result => result.records.filter(r => r.kind === 'page').map(r => new URL(r.url).pathname + new URL(r.url).search);

test('A: the classic /vacatures/<slug> stays a high detail candidate', () => {
  const r = rank('/vacatures/projectleider');
  assert.equal(r.classification, 'detail');
  assert.ok(r.score >= 60);
  assert.ok(r.reasons.includes('detail_path'));
});

test('B: /o/<descriptive slug> is a detail candidate, from a plain link too', () => {
  for (const path of ['/o/senior-software-engineer', '/o/revalidatiearts-volwassenen-revalidatie-10', '/o/hr-specialist-werving-selectie']) {
    const r = rank(path);
    assert.equal(r.classification, 'detail', path);
    assert.ok(r.reasons.includes('short_detail_route'), path);
    assert.ok(r.score >= 40, path);
  }
  assert.equal(rank('/o/hr-manager').classification, 'general', 'two words need a sitemap or listing behind them');
  assert.equal(rank('/o/hr-manager', 'sitemap').classification, 'detail');
  assert.equal(rank('/o/hr-manager', 'listing').classification, 'detail');
});

test('C: a short route alone, or with a generic/one-word/numeric second segment, is not a detail candidate', () => {
  for (const path of ['/o/', '/o', '/o/team', '/o/senior', '/o/contact', '/o/over-ons', '/o/vacatures', '/o/2024-05', '/o/a-b', '/x/y', '/team/our-great-people-here', '/en/senior-software-engineer', '/blog/senior-software-engineer-role']) {
    const r = rank(path, 'sitemap');
    assert.notEqual(r.classification, 'detail', path);
    assert.ok(!r.reasons.includes('short_detail_route'), path);
  }
  // Even a real-looking slug under a search/filter query is not promoted.
  assert.notEqual(rank('/o/senior-software-engineer?q=engineer').classification, 'detail');
});

test('D: an explicit job identifier is a strong detail candidate', () => {
  const r = rank('/jobs/view?jobId=12345');
  assert.equal(r.classification, 'detail');
  assert.ok(r.reasons.includes('job_identifier'));
  assert.ok(r.score >= 75);
  for (const path of ['/careers/opening?vacancyId=a7F3', '/apply?job_id=90210', '/x?position-id=4411', '/x?postingID=778', '/nl/what:job/jobID:966837/', '/nl/what:job/jobid=966837']) {
    const detail = rank(path);
    assert.equal(detail.classification, 'detail', path);
    assert.ok(detail.reasons.includes('job_identifier'), path);
  }
  assert.ok(rank('/x?jobId=12345', 'sitemap').score > rank('/x?jobId=12345').score, 'a sitemap supports the identifier');
  assert.ok(rank('/x?jobId=12345', 'sitemap').reasons.includes('sitemap_detail'));
});

test('D2: identifier matching is exact — ordinary words and empty or non-identifier values never match', () => {
  for (const path of ['/blog/jobid-tips', '/news/job-id-verifier-guide-2024', '/x?jobId=', '/x?jobId=abc', '/x?jobId=1', '/x?subjobId=12345', '/x?myjobid=12345', '/x?id=12345', '/x?jobs=12345', '/jobless/idea-2024', '/about/jobidea1234']) {
    const r = rank(path);
    assert.ok(!r.reasons.includes('job_identifier'), path);
  }
});

test('E: /position/<id> is a detail candidate; a record word without an id, or a word list, is not', () => {
  for (const path of ['/position/12345', '/positions/000123', '/openings/ab-4471', '/opportunity/9981-engineer']) {
    const r = rank(path);
    assert.equal(r.classification, 'detail', path);
    assert.ok(r.reasons.includes('record_id_route'), path);
  }
  for (const path of ['/position', '/positions', '/position/abc', '/position/team', '/position/12', '/openings/overview', '/opportunities/all']) {
    assert.notEqual(rank(path).classification, 'detail', path);
  }
});

test('F: a listing page is a listing, never a detail', () => {
  for (const path of ['/jobs', '/vacatures', '/vacancies', '/careers', '/alle-vacatures']) {
    assert.notEqual(rank(path).classification, 'detail', path);
    assert.ok(rank(path).score < rank('/vacatures/projectleider').score, path);
  }
  assert.equal(rank('/jobs').classification, 'listing');
});

test('G: a search page is never a detail — not with a query, not with an identifier-looking value', () => {
  for (const path of ['/zoeken?query=engineer', '/search?q=developer', '/zoeken?query=jobId%3D12345', '/jobs/search?q=engineer', '/vacatures?filter=it', '/vacatures?page=2']) {
    const r = rank(path);
    assert.notEqual(r.classification, 'detail', path);
  }
  assert.ok(rank('/zoeken?query=engineer').score < 20);
});

test('generic routes keep their low priority: homepage, contact, about, open application', () => {
  for (const path of ['/', '/contact', '/about', '/over-ons', '/open-sollicitatie', '/search', '/zoeken', '/privacy']) {
    assert.ok(rank(path).score < 40, `${path} ${rank(path).score}`);
    assert.notEqual(rank(path).classification, 'detail', path);
  }
});

test('H: in a sitemap, a detail URL outranks a listing URL and a general URL, without a blanket sitemap bonus', () => {
  const detail = rank('/o/senior-software-engineer', 'sitemap');
  const listing = rank('/jobs', 'sitemap');
  const general = rank('/about-the-company', 'sitemap');
  const shortRoute = rank('/o/team', 'sitemap');
  assert.ok(detail.score > listing.score);
  assert.ok(detail.score > general.score);
  assert.equal(general.score, rank('/about-the-company').score, 'a sitemap adds nothing to a non-detail URL');
  assert.equal(shortRoute.score, rank('/o/team').score);
  assert.equal(listing.score, rank('/jobs').score);
});

test('the classic patterns, WBO-like and SPIE-like, rank exactly as before', () => {
  assert.deepEqual(rank('/vacatures/beleidsmedewerker-verduurzaming-scholenbouw-OCW-2026-3171', 'listing'), { score: 90, reasons: ['vacancy_link_tier', 'detail_path', 'unique_detail_slug', 'listing_detail_link'], classification: 'detail' });
  assert.deepEqual(rank('/vacatures/commercie-en-advies/tender-manager-hengelo-1', 'sitemap'), { score: 90, reasons: ['vacancy_link_tier', 'detail_path', 'unique_detail_slug', 'sitemap_detail'], classification: 'detail' });
  assert.deepEqual(rank('/vacatures'), { score: 30, reasons: ['vacancy_link_tier'], classification: 'listing' });
  assert.deepEqual(rank('/'), { score: -5, reasons: ['homepage'], classification: 'general' });
});

test('I: several hundred sitemap URLs never exceed maxCandidates, and the best detail URLs are the ones kept', async () => {
  const detail = Array.from({ length: 300 }, (_, i) => `https://jobs.example/o/vacature-nummer-${i}-medewerker`);
  const noise = Array.from({ length: 400 }, (_, i) => `https://jobs.example/pagina/${i}`);
  const result = await crawlWebsite('https://jobs.example/', {
    ...fakeSite({ '/': links([]), '/sitemap.xml': urlset([...noise, ...detail]) }), extract: page => page.url, maxCandidates: 50, maxPages: 5,
  });
  assert.equal(result.discoveryStats.sitemapUrlsFound, 700);
  assert.ok(result.discoveryStats.candidatesRemaining <= 50, 'the waiting queue never exceeds maxCandidates');
  assert.equal(result.discoveryStats.sitemapCandidatesAccepted + result.discoveryStats.sitemapCandidatesRejected, 700);
  const visited = paths(result).slice(1);
  assert.equal(visited.length, 4);
  assert.ok(visited.every(path => path.startsWith('/o/')), visited.join(','));
  assert.equal(result.candidateLimitReached, true);
});

test('J: the same URL as a page link and as a sitemap entry is one candidate, fetched once, with the stronger evidence', async () => {
  const result = await crawlWebsite('https://jobs.example/', {
    ...fakeSite({
      '/': links([['/o/senior-software-engineer', 'Senior Software Engineer'], ['/o/senior-software-engineer#apply', 'Apply']]),
      '/sitemap.xml': urlset(['https://jobs.example/o/senior-software-engineer', 'https://jobs.example/o/senior-software-engineer?utm_source=x']),
      '/o/senior-software-engineer': links([]),
    }), extract: page => page.url, maxPages: 5,
  });
  assert.equal(paths(result).filter(path => path === '/o/senior-software-engineer').length, 1);
  assert.equal(result.candidates.filter(c => c.canonicalUrl === 'https://jobs.example/o/senior-software-engineer').length, 1);
  const candidate = result.candidates.find(c => c.canonicalUrl === 'https://jobs.example/o/senior-software-engineer');
  assert.ok(candidate.candidateReasons.includes('short_detail_route'));
  assert.ok(candidate.candidateReasons.includes('job_title_anchor') || candidate.candidateReasons.includes('sitemap_detail'));
});

test('Recruitee-shaped site: /o/<slug> links and sitemap entries are detail candidates, visited, and the JobPosting is accepted', async () => {
  const slugs = ['revalidatiearts-volwassenen-revalidatie-10', 'hr-specialist-werving-selectie', 'verpleegkundige-thuiszorg-noord'];
  const result = await crawlWebsite('https://careers.example/', {
    ...fakeSite({
      '/': links([...slugs.map(slug => [`/o/${slug}`, slug.replace(/-/g, ' ')]), ['/', 'Home'], ['/o', 'Alle vacatures'], ['/team', 'Team']]),
      '/sitemap.xml': urlset([...slugs.map(slug => `https://careers.example/o/${slug}`), 'https://careers.example/o', 'https://careers.example/team']),
      ...Object.fromEntries(slugs.map(slug => [`/o/${slug}`, posting(slug.replace(/-/g, ' '))])),
    }), extract: extractVacancy, maxPages: 6,
  });
  const details = result.candidates.filter(c => c.classification === 'detail');
  assert.deepEqual(details.map(c => new URL(c.url).pathname).sort(), slugs.map(slug => `/o/${slug}`).sort());
  assert.equal(result.candidates.find(c => new URL(c.url).pathname === '/o' || new URL(c.url).pathname === '/team').classification === 'detail', false);
  assert.equal(result.extractedPages.filter(page => page.url.includes('/o/')).length, 3, 'every JobPosting is extracted');
  assert.ok(result.extractedPages.every(page => page.data.company === 'Acme Zorg' && page.data.location === 'Delft'));
  assert.equal(result.discoveryStats.sitemapUrlsFound, 5);
  assert.equal(result.candidates.length, new Set(result.candidates.map(c => c.canonicalUrl)).size, 'HTML and sitemap entries are merged');
  assert.ok(result.candidates.find(c => c.url.endsWith(slugs[0])).candidateReasons.includes('sitemap_detail') || result.candidates.find(c => c.url.endsWith(slugs[0])).candidateReasons.includes('listing_detail_link'));
});

test('Varbi-shaped site: colon-and-id job links normalise safely, are detail candidates, and are visited', async () => {
  const ids = [966837, 962361, 965136, 965167];
  const jobPath = id => `/nl/what:job/jobID:${id}/`;
  const result = await crawlWebsite('https://vacatures.example/', {
    ...fakeSite({
      '/': links([...ids.map(id => [jobPath(id), 'Medewerker ' + id]), ['/se/', 'Svenska'], ['/en/', 'English'], ['/nl/', 'Nederlands']]),
      ...Object.fromEntries(ids.map(id => [jobPath(id), links([])])),
    }), extract: page => page.url, maxPages: 6,
  });
  const details = result.candidates.filter(c => c.classification === 'detail');
  assert.equal(details.length, ids.length);
  assert.ok(details.every(c => c.candidateReasons.includes('job_identifier')));
  assert.ok(details.every(c => c.candidateScore >= 60));
  assert.ok(result.candidates.filter(c => c.classification !== 'detail').every(c => c.candidateScore < 20));
  for (const id of ids) assert.ok(paths(result).includes(jobPath(id)), `${id} visited`);
  // Language switchers are visited after the job pages, never before.
  assert.ok(paths(result).indexOf(jobPath(966837)) < paths(result).indexOf('/se/') || !paths(result).includes('/se/'));
});

test('a start page with almost no detail links still yields detail candidates through the sitemap (Wolf/Volker-shaped)', async () => {
  const jobs = Array.from({ length: 60 }, (_, i) => `https://shop.example/vacature/${1000 + i}/medewerker-${i}`);
  const result = await crawlWebsite('https://shop.example/', {
    ...fakeSite({
      '/': links([['/over-ons', 'Over ons'], ['/contact', 'Contact'], ['/vacatures', 'Vacatures']]),
      '/sitemap.xml': urlset([...jobs, 'https://shop.example/over-ons', 'https://shop.example/contact']),
    }), extract: page => page.url, maxPages: 4,
  });
  assert.equal(result.candidates.filter(c => c.classification === 'detail').length, 60);
  assert.equal(result.discoveryStats.highConfidenceCandidates >= 60, true);
  const visited = paths(result);
  assert.equal(visited[0], '/');
  assert.ok(visited.slice(1).every(path => path.startsWith('/vacature/')), visited.join(','));
});

test('a sitemap index lists the relevant child first, so a small metadata budget is not spent on blog and event sitemaps', async () => {
  const children = ['blog', 'company', 'event', 'option', 'page', 'testimonial', 'vacancy', 'video'];
  const jobUrls = Array.from({ length: 20 }, (_, i) => `https://big.example/vacature/${2000 + i}/functie-${i}`);
  const requests = [];
  const result = await crawlWebsite('https://big.example/', {
    ...fakeSite({
      '/': links([]),
      '/sitemap.xml': `<sitemapindex>${children.map(name => `<sitemap><loc>https://big.example/sitemap.${name}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
      ...Object.fromEntries(children.map(name => [`/sitemap.${name}.xml`, urlset(name === 'vacancy' ? jobUrls : [`https://big.example/${name}/x`])])),
    }, requests), extract: page => page.url, maxPages: 3,
  });
  assert.ok(requests.includes('/sitemap.vacancy.xml'), requests.join(' '));
  assert.equal(result.candidates.filter(c => c.classification === 'detail').length, 20);
  assert.equal(result.records.filter(r => r.kind !== 'page' && r.attempted).length <= 8, true, 'the request budget is unchanged');
});

test('a redirected sitemap and the same sitemap named in robots.txt are fetched once', async () => {
  const requests = [];
  await crawlWebsite('https://redir.example/', {
    ...fakeSite({
      '/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://redir.example/sitemap_index.xml',
      '/': links([]),
      '/sitemap.xml': { redirect: 'https://redir.example/sitemap_index.xml' },
      '/sitemap_index.xml': `<sitemapindex><sitemap><loc>https://redir.example/job-sitemap.xml</loc></sitemap></sitemapindex>`,
      '/job-sitemap.xml': urlset(['https://redir.example/vacature/1234/engineer']),
    }, requests), extract: page => page.url, maxPages: 3,
  });
  assert.equal(requests.filter(path => path === '/sitemap_index.xml').length, 1, requests.join(' '));
  assert.ok(requests.includes('/job-sitemap.xml'));
});

test('an index without any relevant child keeps its own order (no reordering without a signal)', async () => {
  const requests = [];
  await crawlWebsite('https://plain.example/', {
    ...fakeSite({
      '/': links([]),
      '/sitemap.xml': `<sitemapindex>${['a', 'b', 'c'].map(name => `<sitemap><loc>https://plain.example/${name}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
      '/a.xml': urlset([]), '/b.xml': urlset([]), '/c.xml': urlset([]),
    }, requests), extract: page => page.url, maxPages: 2,
  });
  assert.deepEqual(requests.filter(path => path.endsWith('.xml')), ['/sitemap.xml', '/a.xml', '/b.xml', '/c.xml']);
});
