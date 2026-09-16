import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCandidateUrls } from '../dist/search/candidates.js';

function candidate(url, overrides = {}) {
  return { url, title: 'Title', snippet: 'Snippet', source: 'brave', ...overrides };
}

test('exact-duplicate URLs are removed, keeping only the first occurrence', () => {
  const result = normalizeCandidateUrls([candidate('https://acme.example/a'), candidate('https://acme.example/a')]);
  assert.equal(result.length, 1);
});

test('duplicate URLs that only differ by tracking params or a fragment are treated as the same candidate', () => {
  const result = normalizeCandidateUrls([
    candidate('https://acme.example/vacatures/backend?utm_source=brave&utm_campaign=x'),
    candidate('https://acme.example/vacatures/backend#apply'),
  ]);
  assert.equal(result.length, 1);
});

test('a non-http(s) URL (javascript:, mailto:, ftp:) is dropped, never treated as a fetchable candidate', () => {
  const result = normalizeCandidateUrls([
    candidate('javascript:alert(1)'),
    candidate('mailto:jobs@acme.example'),
    candidate('ftp://acme.example/file'),
    candidate('https://acme.example/real-page'),
  ]);
  assert.deepEqual(result.map(c => c.url), ['https://acme.example/real-page']);
});

test('a garbage/unparseable URL is dropped rather than throwing', () => {
  const result = normalizeCandidateUrls([candidate('not a url at all'), candidate('https://acme.example/ok')]);
  assert.deepEqual(result.map(c => c.url), ['https://acme.example/ok']);
});

test('a search-engine/tracking-redirect host (google, bing, doubleclick, the search provider\'s own domain, ...) is never crawled as a candidate', () => {
  const result = normalizeCandidateUrls([
    candidate('https://www.google.com/search?q=vacatures'),
    candidate('https://www.bing.com/search?q=vacatures'),
    candidate('https://search.brave.com/search?q=vacatures'),
    candidate('https://securepubads.doubleclick.net/x'),
    candidate('https://acme.example/vacatures/backend-developer'),
  ]);
  assert.deepEqual(result.map(c => c.url), ['https://acme.example/vacatures/backend-developer']);
});

test('respects a conservative maximum number of candidates per run', () => {
  const many = Array.from({ length: 25 }, (_, i) => candidate(`https://acme.example/vacature-${i}`));
  const result = normalizeCandidateUrls(many, { maxCandidates: 10 });
  assert.equal(result.length, 10);
});

test('defaults the maximum to 10 when none is given', () => {
  const many = Array.from({ length: 15 }, (_, i) => candidate(`https://acme.example/vacature-${i}`));
  assert.equal(normalizeCandidateUrls(many).length, 10);
});

test('every candidate keeps its own title/snippet/source metadata, only the url is normalized', () => {
  const result = normalizeCandidateUrls([candidate('https://acme.example/a?utm_source=x', { title: 'A title', snippet: 'A snippet', source: 'brave' })]);
  assert.deepEqual(result, [{ url: 'https://acme.example/a', title: 'A title', snippet: 'A snippet', source: 'brave' }]);
});
