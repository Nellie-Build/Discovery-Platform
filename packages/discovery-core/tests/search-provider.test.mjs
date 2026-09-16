import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBraveSearchProvider } from '../dist/search/provider.js';

function fakeFetch(jsonBody) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => jsonBody };
  };
  return { fetchImpl, calls };
}

const braveResponse = {
  web: {
    results: [
      { title: 'Backend Developer - Acme', url: 'https://acme.example/vacatures/backend-developer', description: 'Werk bij Acme als backend developer.' },
      { title: 'Frontend Developer - Acme', url: 'https://acme.example/vacatures/frontend-developer', description: 'Werk bij Acme als frontend developer.' },
    ],
  },
};

test('createBraveSearchProvider sends the query, country and search_lang as documented, with the key only in the subscription-token header', async () => {
  const { fetchImpl, calls } = fakeFetch(braveResponse);
  const provider = createBraveSearchProvider('test-key', { fetchImpl });
  await provider.search({ query: 'vacature vacatures jobs Security Nederland', country: 'NL', language: 'nl', count: 5 });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('q'), 'vacature vacatures jobs Security Nederland');
  assert.equal(url.searchParams.get('country'), 'NL');
  assert.equal(url.searchParams.get('search_lang'), 'nl');
  assert.equal(url.searchParams.get('count'), '5');
  assert.equal(calls[0].init.headers['x-subscription-token'], 'test-key');
});

test('search() returns url/title/snippet/source for every result, dropping nothing the caller needs', async () => {
  const { fetchImpl } = fakeFetch(braveResponse);
  const provider = createBraveSearchProvider('test-key', { fetchImpl });
  const results = await provider.search({ query: 'x' });
  assert.deepEqual(results, [
    { url: 'https://acme.example/vacatures/backend-developer', title: 'Backend Developer - Acme', snippet: 'Werk bij Acme als backend developer.', source: 'brave' },
    { url: 'https://acme.example/vacatures/frontend-developer', title: 'Frontend Developer - Acme', snippet: 'Werk bij Acme als frontend developer.', source: 'brave' },
  ]);
});

test('a result missing its own url is silently dropped, never a candidate with an empty/undefined url', async () => {
  const { fetchImpl } = fakeFetch({ web: { results: [{ title: 'No URL here' }, { title: 'Has one', url: 'https://example.test/a' }] } });
  const provider = createBraveSearchProvider('test-key', { fetchImpl });
  const results = await provider.search({ query: 'x' });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.test/a');
});

test('no results at all (missing web.results) yields an empty array, never a throw', async () => {
  const { fetchImpl } = fakeFetch({});
  const provider = createBraveSearchProvider('test-key', { fetchImpl });
  assert.deepEqual(await provider.search({ query: 'x' }), []);
});

test('search() rejects a non-OK response and a malformed JSON answer, never leaking a raw body', async () => {
  const notOk = createBraveSearchProvider('test-key', { fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(notOk.search({ query: 'x' }), /Brave Search-aanroep mislukt \(status 401\)/);

  const malformed = createBraveSearchProvider('test-key', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) });
  await assert.rejects(malformed.search({ query: 'x' }), /geen geldige JSON/);
});

test('search() refuses to call Brave at all when no API key is configured, and the error message never contains a key value', async () => {
  const provider = createBraveSearchProvider('', { fetchImpl: async () => { throw new Error('must never be called'); } });
  await assert.rejects(provider.search({ query: 'x' }), /BRAVE_SEARCH_API_KEY is niet geconfigureerd/);
});

test('the API key is never logged: the only place it appears is the request header, never in a thrown error message', async () => {
  const { fetchImpl, calls } = fakeFetch(braveResponse);
  const provider = createBraveSearchProvider('super-secret-key', { fetchImpl });
  await provider.search({ query: 'x' });
  assert.equal(calls[0].init.headers['x-subscription-token'], 'super-secret-key');
  // Simulate a failure response from Brave and confirm the key never leaks into the error text.
  const failing = createBraveSearchProvider('super-secret-key', { fetchImpl: async () => ({ ok: false, status: 500 }) });
  try {
    await failing.search({ query: 'x' });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.ok(!String(error.message).includes('super-secret-key'));
  }
});
