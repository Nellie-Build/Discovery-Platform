import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBraveSearchProvider, createTavilySearchProvider, createConfiguredSearchProvider } from '../dist/search/provider.js';

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

// ─── Tavily (an alternative provider — same SourceSearchProvider contract, its own REST shape) ───────────────────────

const tavilyResponse = {
  query: 'vacature vacatures jobs Security Nederland',
  results: [
    { title: 'Backend Developer - Acme', url: 'https://acme.example/vacatures/backend-developer', content: 'Werk bij Acme als backend developer.', score: 0.9 },
    { title: 'Frontend Developer - Acme', url: 'https://acme.example/vacatures/frontend-developer', content: 'Werk bij Acme als frontend developer.', score: 0.8 },
  ],
};

test('createTavilySearchProvider sends the query, search depth and count as documented, with the key only in the Authorization header', async () => {
  const { fetchImpl, calls } = fakeFetch(tavilyResponse);
  const provider = createTavilySearchProvider('test-key', { fetchImpl });
  await provider.search({ query: 'vacature vacatures jobs Security Nederland', count: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { query: 'vacature vacatures jobs Security Nederland', search_depth: 'basic', max_results: 5 });
});

test('createTavilySearchProvider defaults to the cheapest "basic" search depth (1 credit/call on the free plan)', async () => {
  const { fetchImpl, calls } = fakeFetch(tavilyResponse);
  await createTavilySearchProvider('test-key', { fetchImpl }).search({ query: 'x' });
  assert.equal(JSON.parse(calls[0].init.body).search_depth, 'basic');
  const { fetchImpl: advancedFetch, calls: advancedCalls } = fakeFetch(tavilyResponse);
  await createTavilySearchProvider('test-key', { fetchImpl: advancedFetch, searchDepth: 'advanced' }).search({ query: 'x' });
  assert.equal(JSON.parse(advancedCalls[0].init.body).search_depth, 'advanced');
});

test('Tavily search() returns url/title/snippet/source for every result, dropping nothing the caller needs', async () => {
  const { fetchImpl } = fakeFetch(tavilyResponse);
  const provider = createTavilySearchProvider('test-key', { fetchImpl });
  const results = await provider.search({ query: 'x' });
  assert.deepEqual(results, [
    { url: 'https://acme.example/vacatures/backend-developer', title: 'Backend Developer - Acme', snippet: 'Werk bij Acme als backend developer.', source: 'tavily' },
    { url: 'https://acme.example/vacatures/frontend-developer', title: 'Frontend Developer - Acme', snippet: 'Werk bij Acme als frontend developer.', source: 'tavily' },
  ]);
});

test('Tavily: a result missing its own url is silently dropped; no results at all yields an empty array; a non-OK response and malformed JSON are rejected without leaking the key', async () => {
  const { fetchImpl } = fakeFetch({ results: [{ title: 'No URL here' }, { title: 'Has one', url: 'https://example.test/a' }] });
  const dropped = await createTavilySearchProvider('test-key', { fetchImpl }).search({ query: 'x' });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].url, 'https://example.test/a');

  const { fetchImpl: emptyFetch } = fakeFetch({});
  assert.deepEqual(await createTavilySearchProvider('test-key', { fetchImpl: emptyFetch }).search({ query: 'x' }), []);

  const notOk = createTavilySearchProvider('super-secret-key', { fetchImpl: async () => ({ ok: false, status: 401 }) });
  try {
    await notOk.search({ query: 'x' });
    assert.fail('expected a rejection');
  } catch (error) {
    assert.match(error.message, /Tavily Search-aanroep mislukt \(status 401\)/);
    assert.ok(!error.message.includes('super-secret-key'));
  }

  const malformed = createTavilySearchProvider('test-key', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }) });
  await assert.rejects(malformed.search({ query: 'x' }), /geen geldige JSON/);
});

test('Tavily search() refuses to call the API at all when no key is configured', async () => {
  const provider = createTavilySearchProvider('', { fetchImpl: async () => { throw new Error('must never be called'); } });
  await assert.rejects(provider.search({ query: 'x' }), /TAVILY_API_KEY is niet geconfigureerd/);
});

// ─── createConfiguredSearchProvider: the provider CHOICE, kept in this domain-neutral package ────────────────────────

test('createConfiguredSearchProvider: with no explicit choice, whichever key is set wins — Tavily first when both are', async () => {
  assert.equal(createConfiguredSearchProvider({}), undefined, 'neither configured: no provider, never a failure');

  const { fetchImpl: braveFetch } = fakeFetch(braveResponse);
  const brave = await createConfiguredSearchProvider({ braveApiKey: 'b' }, { fetchImpl: braveFetch }).search({ query: 'x' });
  assert.deepEqual(brave.map(r => r.source), ['brave', 'brave']);

  const { fetchImpl: tavilyFetch } = fakeFetch(tavilyResponse);
  const tavily = await createConfiguredSearchProvider({ tavilyApiKey: 't' }, { fetchImpl: tavilyFetch }).search({ query: 'x' });
  assert.deepEqual(tavily.map(r => r.source), ['tavily', 'tavily']);

  // Both configured, no explicit choice: Tavily wins (the one with a free plan for local acceptance testing).
  const { fetchImpl: bothFetch } = fakeFetch(tavilyResponse);
  const both = await createConfiguredSearchProvider({ tavilyApiKey: 't', braveApiKey: 'b' }, { fetchImpl: bothFetch }).search({ query: 'x' });
  assert.deepEqual(both.map(r => r.source), ['tavily', 'tavily']);
});

test('createConfiguredSearchProvider: an explicit provider choice wins even when the other key is also set', async () => {
  const { fetchImpl: braveFetch } = fakeFetch(braveResponse);
  const configuredBrave = createConfiguredSearchProvider({ provider: 'brave', tavilyApiKey: 't', braveApiKey: 'b' }, { fetchImpl: braveFetch });
  assert.deepEqual((await configuredBrave.search({ query: 'x' })).map(r => r.source), ['brave', 'brave']);
});

test('createConfiguredSearchProvider: an explicit choice with no matching key configured is treated as "nothing configured", never a throw', () => {
  assert.equal(createConfiguredSearchProvider({ provider: 'tavily' }), undefined);
  assert.equal(createConfiguredSearchProvider({ provider: 'brave' }), undefined);
  assert.equal(createConfiguredSearchProvider({ provider: 'tavily', braveApiKey: 'b' }), undefined, 'the other provider\'s key does not substitute for the chosen one');
});
