import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAndExtractPage } from '../dist/crawler/single-page.js';

function html(body) {
  return `<html><head><title>T</title></head><body>${body}</body></html>`;
}
function transportFor(pages) {
  return async url => {
    const page = pages[url];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body ?? html('')) };
  };
}
const normalizePhone = raw => { const d = raw.replace(/[^\d+]/g, ''); return /^\+?\d{8,15}$/.test(d) ? d : null; };
const normalizeEmail = raw => { const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null; };
const contactNormalizers = { normalizePhone, normalizeEmail };
const titleExtract = page => ({ title: page.$('title').first().text() || undefined });

test('fetches exactly the given URL (never re-derives a homepage from it) and hands the page to the caller\'s own extract()', async () => {
  const url = 'https://acme.example/vacatures/backend-developer';
  const transport = transportFor({ [url]: { body: html('<h1>Backend Developer</h1>') } });
  const result = await fetchAndExtractPage(url, { extract: titleExtract, contactNormalizers, transport });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.url, url);
  assert.deepEqual(result.data, [{ title: 'T' }]);
});

test('an extract() returning undefined yields data: undefined, never an empty array standing in for "nothing found"', async () => {
  const url = 'https://acme.example/no-facts-here';
  const transport = transportFor({ [url]: {} });
  const result = await fetchAndExtractPage(url, { extract: () => undefined, contactNormalizers, transport });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data, undefined);
});

test('a non-2xx response is reported as failed with the HTTP status, never thrown as an uncaught error', async () => {
  const url = 'https://acme.example/missing';
  const transport = transportFor({ [url]: { status: 404 } });
  const result = await fetchAndExtractPage(url, { extract: titleExtract, contactNormalizers, transport });
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, 404);
  assert.equal(result.data, undefined);
});

test('a non-HTML response (e.g. a PDF) is rejected, never parsed as if it were a page', async () => {
  const url = 'https://acme.example/vacature.pdf';
  const transport = transportFor({ [url]: { contentType: 'application/pdf', body: '%PDF-1.4' } });
  const result = await fetchAndExtractPage(url, { extract: titleExtract, contactNormalizers, transport });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Geen HTML-pagina/);
});

test('a non-http(s) URL is rejected before any transport call is made', async () => {
  const result = await fetchAndExtractPage('javascript:alert(1)', {
    extract: titleExtract, contactNormalizers, transport: async () => { throw new Error('must never be called'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, null);
});

test('a transport failure (network error) is reported as failed, never an uncaught rejection', async () => {
  const result = await fetchAndExtractPage('https://acme.example/x', {
    extract: titleExtract, contactNormalizers, transport: async () => { throw new Error('Niet-publiek netwerkadres geweigerd.'); },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Niet-publiek netwerkadres geweigerd/);
});

test('contact details on the candidate page (mailto:/tel: links) are extracted exactly like a normal crawl page', async () => {
  const url = 'https://acme.example/vacatures/backend-developer';
  const transport = transportFor({ [url]: { body: html('<a href="mailto:jobs@acme.example">Apply</a>') } });
  let seenContacts = null;
  const result = await fetchAndExtractPage(url, {
    extract: page => { seenContacts = page.contacts; return undefined; },
    contactNormalizers, transport,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(seenContacts.email, 'jobs@acme.example');
});
