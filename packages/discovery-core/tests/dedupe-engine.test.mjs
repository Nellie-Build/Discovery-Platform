import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreMatch, haversineDistanceMeters, findDuplicateCandidates } from '../dist/dedupe/engine.js';

const THRESHOLDS = { strongMatch: 90, possibleDuplicate: 50 };

test('scoreMatch sums matched signal points, clamps, and applies thresholds', () => {
  assert.deepEqual(scoreMatch([{ id: 'a', points: 100 }], { thresholds: THRESHOLDS }), { score: 100, matchedSignals: ['a'], decision: 'strong_match' });
  assert.deepEqual(scoreMatch([{ id: 'a', points: 60 }], { thresholds: THRESHOLDS }), { score: 60, matchedSignals: ['a'], decision: 'possible_duplicate' });
  assert.deepEqual(scoreMatch([{ id: 'a', points: 20 }], { thresholds: THRESHOLDS }), { score: 20, matchedSignals: ['a'], decision: 'none' });
  assert.deepEqual(scoreMatch([], { thresholds: THRESHOLDS }), { score: 0, matchedSignals: [], decision: 'none' });
});

test('scoreMatch clamps a combined score above 100 down to the configured max', () => {
  const result = scoreMatch([{ id: 'a', points: 60 }, { id: 'b', points: 60 }], { thresholds: THRESHOLDS });
  assert.equal(result.score, 100);
  assert.equal(result.decision, 'strong_match');
});

test('haversineDistanceMeters matches a known reference distance and is zero for identical points', () => {
  const distance = haversineDistanceMeters({ latitude: 31.6295, longitude: -7.9811 }, { latitude: 31.6135, longitude: -8.0206 });
  assert.ok(distance > 4000 && distance < 6500, `expected roughly 5.4km, got ${distance}m`);
  assert.equal(haversineDistanceMeters({ latitude: 31.63, longitude: -7.98 }, { latitude: 31.63, longitude: -7.98 }), 0);
});

function record(id, overrides = {}) {
  return { id, key: null, coords: null, ...overrides };
}
const baseOptions = {
  idOf: r => r.id,
  exactSignals: [{ id: 'key', points: 100, keyOf: r => r.key }],
  thresholds: THRESHOLDS,
};

test('findDuplicateCandidates blocks by an exact key and returns a strong_match pair, never the record with a null key', () => {
  const a = record('a', { key: 'x' });
  const b = record('b', { key: 'x' });
  const c = record('c', { key: null });
  const candidates = findDuplicateCandidates([a, b, c], baseOptions);
  assert.equal(candidates.length, 1);
  assert.deepEqual(new Set([candidates[0].recordA.id, candidates[0].recordB.id]), new Set(['a', 'b']));
  assert.equal(candidates[0].decision, 'strong_match');
});

test('findDuplicateCandidates combines several matched signals for the same pair into one candidate', () => {
  const a = record('a', { key: 'x', tag: 'y' });
  const b = record('b', { key: 'x', tag: 'y' });
  const options = {
    idOf: r => r.id,
    exactSignals: [{ id: 'key', points: 40, keyOf: r => r.key }, { id: 'tag', points: 40, keyOf: r => r.tag }],
    thresholds: THRESHOLDS,
  };
  const candidates = findDuplicateCandidates([a, b], options);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].score, 80);
  assert.deepEqual(new Set(candidates[0].matchedSignals), new Set(['key', 'tag']));
  assert.equal(candidates[0].decision, 'possible_duplicate');
});

test('findDuplicateCandidates never returns a pair scoring below the possible-duplicate threshold', () => {
  const a = record('a', { key: 'x' });
  const b = record('b', { key: 'x' });
  const options = { idOf: r => r.id, exactSignals: [{ id: 'key', points: 10, keyOf: r => r.key }], thresholds: THRESHOLDS };
  assert.deepEqual(findDuplicateCandidates([a, b], options), []);
});

test('findDuplicateCandidates supports a fuzzy distance signal, matching only within the threshold', () => {
  const a = record('a', { coords: { latitude: 31.63, longitude: -7.98 } });
  const bClose = record('b', { coords: { latitude: 31.630003, longitude: -7.980003 } }); // well under 50m
  const bFar = record('c', { coords: { latitude: 31.635, longitude: -7.98 } }); // roughly 550m
  const options = {
    idOf: r => r.id,
    distanceSignals: [{ id: 'coords', points: 100, thresholdMeters: 50, coordsOf: r => r.coords }],
    thresholds: THRESHOLDS,
  };
  const closeCandidates = findDuplicateCandidates([a, bClose], options);
  assert.equal(closeCandidates.length, 1);
  assert.equal(closeCandidates[0].decision, 'strong_match');
  assert.deepEqual(findDuplicateCandidates([a, bFar], options), []);
});

test('findDuplicateCandidates sorts results by score descending', () => {
  const strongA = record('a', { key: 'strong' }), strongB = record('b', { key: 'strong' });
  const weakA = record('c', { weakKey: 'w' }), weakB = record('d', { weakKey: 'w' });
  const combined = findDuplicateCandidates([strongA, strongB, weakA, weakB], {
    idOf: r => r.id,
    exactSignals: [{ id: 'key', points: 100, keyOf: r => r.key }, { id: 'weak', points: 60, keyOf: r => r.weakKey }],
    thresholds: THRESHOLDS,
  });
  assert.equal(combined.length, 2);
  assert.ok(combined[0].score >= combined[1].score);
  assert.equal(combined[0].decision, 'strong_match');
});
