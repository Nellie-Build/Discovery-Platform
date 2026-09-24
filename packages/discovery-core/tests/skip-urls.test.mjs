import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscoveryCrawler } from '../dist/crawler/discovery-crawler.js';

/** `skipUrls`: pages the caller already fetched are never requested by the crawl, in either engine; the start page always is. */
const PAGES = {
  '/robots.txt': { ct: 'text/plain', b: 'User-agent: *\nAllow: /' },
  '/sitemap.xml': { ct: 'application/xml', b: '<urlset></urlset>' },
  '/': { ct: 'text/html', b: '<html><title>Home</title><a href="/a">a</a><a href="/b">b</a></html>' },
  '/a': { ct: 'text/html', b: '<html><title>A</title></html>' },
  '/b': { ct: 'text/html', b: '<html><title>B</title></html>' },
};
const contactNormalizers = { normalizePhone: v => v, normalizeEmail: v => v };
const clock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };

for (const engine of ['legacy', 'crawlee']) {
  test(`${engine}: skipUrls are neither queued nor requested; the start page is fetched even when listed`, async () => {
    const requested = [];
    const transport = async url => { requested.push(new URL(url).pathname); const page = PAGES[new URL(url).pathname]; return page ? { status: 200, headers: { 'content-type': page.ct }, body: Buffer.from(page.b) } : { status: 404, headers: {}, body: Buffer.from('') }; };
    const result = await createDiscoveryCrawler(engine).crawl('https://site.example/', {
      transport, clock: clock(), contactNormalizers, extract: page => ({ path: new URL(page.url).pathname }),
      skipUrls: ['https://site.example/a', 'https://site.example/', 'https://site.example/does-not-matter'],
    });
    assert.deepEqual(requested.filter(p => !/robots|sitemap/.test(p)).sort(), ['/', '/b']);
    assert.deepEqual(result.extractedPages.map(p => p.data.path).sort(), ['/', '/b']);
  });
}
