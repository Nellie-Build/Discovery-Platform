import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScoring } from '../dist/scoring/engine.js';

test('runScoring sums the points of every rule that fires, ignores rules returning null', () => {
  const record = { value: 5 };
  const rules = [
    { id: 'a', evaluate: r => (r.value > 0 ? { points: 10, reason: 'positive' } : null) },
    { id: 'b', evaluate: () => null },
    { id: 'c', evaluate: () => ({ points: 20, reason: 'always' }) },
  ];
  const result = runScoring(record, rules);
  assert.equal(result.score, 30);
  assert.deepEqual(result.contributions.map(c => c.reason), ['positive', 'always']);
});

test('runScoring splits reasons by sign; a null contribution appears in neither list', () => {
  const rules = [
    { id: 'pos', evaluate: () => ({ points: 15, reason: 'up' }) },
    { id: 'neg', evaluate: () => ({ points: -40, reason: 'down' }) },
    { id: 'skip', evaluate: () => null },
  ];
  const result = runScoring({}, rules, { min: 0, max: 100 });
  assert.deepEqual(result.positiveReasons.map(c => c.reason), ['up']);
  assert.deepEqual(result.negativeReasons.map(c => c.reason), ['down']);
  assert.equal(result.score, 0); // clamped: 15 - 40 = -25 -> 0
});

test('runScoring clamps to a custom min/max range', () => {
  const rules = [{ id: 'big', evaluate: () => ({ points: 500, reason: 'huge' }) }];
  const result = runScoring({}, rules, { max: 20 });
  assert.equal(result.score, 20);
});

test('runScoring applies an optional cap function after the raw clamp, without knowing why', () => {
  // The generic engine never learns what "hardReject" means — this mirrors how an
  // accommodation-style domain might cap the score for a hotel/corporate lead at 20, and how a
  // completely different domain could cap for a completely different reason, using the exact
  // same mechanism.
  const record = { hardReject: true };
  const rules = [{ id: 'strong', evaluate: () => ({ points: 90, reason: 'strong signal' }) }];
  const result = runScoring(record, rules, {
    cap: (rec, raw) => (rec.hardReject ? Math.min(raw, 20) : raw),
  });
  assert.equal(result.score, 20);
});

test('runScoring with no rules and no options returns a zero score and empty reason lists', () => {
  const result = runScoring({}, []);
  assert.equal(result.score, 0);
  assert.deepEqual(result.contributions, []);
  assert.deepEqual(result.positiveReasons, []);
  assert.deepEqual(result.negativeReasons, []);
});
