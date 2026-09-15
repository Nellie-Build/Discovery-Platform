import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crawlBasic } from '../crawl-site.mjs';

/** Injectable in-memory transport — no real network access, no external test fixtures. */
function fakeSite(pages) {
  return async url => {
    const page = pages[new URL(url).pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body) };
  };
}
const fakeClock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };

test('a totally generic program can crawl a site, get each page\'s title/text, and find contact details — using only @discovery-platform/core\'s public API', async () => {
  const pages = {
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': { contentType: 'application/xml', body: '<urlset></urlset>' },
    '/': { body: '<html><head><title>Example Co</title></head><body><a href="/contact">Contact</a><p>Welcome to Example Co.</p></body></html>' },
    '/contact': { body: `<html><head><title>Contact</title></head><body>
      <a href="mailto:info@example-co.test">Email</a>
      <a href="tel:+15551234567">Call</a>
    </body></html>` },
  };
  const result = await crawlBasic('https://example-co.test', { transport: fakeSite(pages), clock: fakeClock() });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.pagesVisited, 2);
  assert.deepEqual(result.contacts, { email: 'info@example-co.test', phone: '+15551234567', whatsapp: null, instagram: null, facebook: null });
  const home = result.pages.find(p => p.url === 'https://example-co.test/');
  assert.equal(home.title, 'Example Co');
  assert.ok(home.text.includes('Welcome to Example Co.'));
});

test('never needed anything beyond crawlBasic\'s one URL argument — no accommodation, scoring, claim, database, React or Firebase concept in crawl-site.mjs\'s actual code (comments excluded, since they legitimately explain what this example deliberately avoids)', async () => {
  const raw = await (await import('node:fs/promises')).readFile(new URL('../crawl-site.mjs', import.meta.url), 'utf8');
  const code = raw.replace(/\/\/.*$/gm, '');
  for (const forbidden of [/accommodat/i, /\bscor/i, /\bclaim/i, /firebase/i, /firestore/i, /\breact\b/i, /discovery_leads/i, /\bpg\b/, /postgres/i]) {
    assert.ok(!forbidden.test(code), forbidden);
  }
});
