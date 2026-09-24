import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRobotsPolicy } from '../dist/crawler/robots.js';
import { fetchAndExtractPage } from '../dist/crawler/single-page.js';

const contactNormalizers = { normalizePhone: v => v, normalizeEmail: v => v };
function site(pages) {
  const calls = [];
  const transport = async url => {
    calls.push(new URL(url).pathname);
    const p = pages[new URL(url).pathname];
    return p ? { status: p.status ?? 200, headers: { 'content-type': p.ct ?? 'text/html' }, body: Buffer.from(p.b ?? '<html><title>x</title></html>') } : { status: 404, headers: {}, body: Buffer.from('') };
  };
  return { calls, transport };
}

test('robots policy: disallowed paths are refused, others allowed; robots.txt is fetched once per origin', async () => {
  const { transport, calls } = site({ '/robots.txt': { ct: 'text/plain', b: 'User-agent: *\nDisallow: /prive/' } });
  const policy = createRobotsPolicy({ transport });
  assert.deepEqual(await policy.check('https://a.example/open/x'), { allowed: true, reason: null });
  assert.equal((await policy.check('https://a.example/prive/x')).allowed, false);
  assert.equal((await policy.check('https://a.example/open/y')).allowed, true);
  assert.deepEqual(calls, ['/robots.txt']);
});

test('robots policy: a missing robots.txt (404) allows; an unreadable one (500, network error, non-public address) blocks, like the crawl', async () => {
  assert.equal((await createRobotsPolicy({ transport: site({}).transport }).check('https://a.example/x')).allowed, true);
  assert.equal((await createRobotsPolicy({ transport: site({ '/robots.txt': { status: 500 } }).transport }).check('https://a.example/x')).allowed, false);
  assert.equal((await createRobotsPolicy({ transport: async () => { throw new Error('Niet-publiek netwerkadres geweigerd.'); } }).check('https://a.example/x')).allowed, false);
});

test('robots policy: the default transport is the SSRF-safe one (a private address is never contacted; the origin is blocked)', async () => {
  const verdict = await createRobotsPolicy().check('http://127.0.0.1:9/pagina');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /robots\.txt kon niet betrouwbaar/);
});

test('fetchAndExtractPage: without the option nothing changes (no robots request); with it a blocked page is not requested and says so', async () => {
  const { transport, calls } = site({ '/robots.txt': { ct: 'text/plain', b: 'User-agent: *\nDisallow: /prive/' }, '/prive/a': {}, '/open/a': {} });
  const options = { extract: () => 1, contactNormalizers, transport };
  const plain = await fetchAndExtractPage('https://a.example/prive/a', options);
  assert.equal(plain.status, 'succeeded');
  assert.deepEqual(calls, ['/prive/a']);
  calls.length = 0;
  const robots = createRobotsPolicy({ transport });
  const blocked = await fetchAndExtractPage('https://a.example/prive/a', { ...options, robots });
  assert.deepEqual([blocked.status, blocked.blockedBy, blocked.data], ['failed', 'robots', undefined]);
  assert.deepEqual(calls, ['/robots.txt'], 'only robots.txt was requested');
  const allowed = await fetchAndExtractPage('https://a.example/open/a', { ...options, robots });
  assert.equal(allowed.status, 'succeeded');
  assert.deepEqual(calls, ['/robots.txt', '/open/a'], 'robots.txt is reused for the second page');
});
