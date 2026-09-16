import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeJobBoardLocation } from '../dist/sources/location.js';

test('Nederland is correctly mapped to ts-jobspy\'s country value and an English location', () => {
  assert.deepEqual(normalizeJobBoardLocation('Nederland'), { location: 'Netherlands', country: 'netherlands' });
});

test('the English spelling ("Netherlands") is recognized just as well as the Dutch one', () => {
  assert.deepEqual(normalizeJobBoardLocation('Netherlands'), { location: 'Netherlands', country: 'netherlands' });
});

test('Zuid-Holland is used as a location but never treated as a country', () => {
  const result = normalizeJobBoardLocation('Zuid-Holland');
  assert.equal(result.location, 'Zuid-Holland');
  assert.equal(result.country, null);
});

test('Den Haag stays a location, never a country', () => {
  const result = normalizeJobBoardLocation('Den Haag');
  assert.equal(result.location, 'Den Haag');
  assert.equal(result.country, null);
});

test('Rotterdam stays a location, never a country', () => {
  assert.deepEqual(normalizeJobBoardLocation('Rotterdam'), { location: 'Rotterdam', country: null });
});

test('België and Belgie both map to the belgium country value', () => {
  assert.deepEqual(normalizeJobBoardLocation('België'), { location: 'Belgium', country: 'belgium' });
  assert.deepEqual(normalizeJobBoardLocation('Belgie'), { location: 'Belgium', country: 'belgium' });
});

test('Antwerpen stays a location, never a country', () => {
  assert.deepEqual(normalizeJobBoardLocation('Antwerpen'), { location: 'Antwerpen', country: null });
});

test('Duitsland maps to the germany country value', () => {
  assert.deepEqual(normalizeJobBoardLocation('Duitsland'), { location: 'Germany', country: 'germany' });
});

test('Berlin stays a location, never a country', () => {
  assert.deepEqual(normalizeJobBoardLocation('Berlin'), { location: 'Berlin', country: null });
});

test('an empty or whitespace-only region yields no location and no country at all — never guessed', () => {
  assert.deepEqual(normalizeJobBoardLocation(''), { location: null, country: null });
  assert.deepEqual(normalizeJobBoardLocation('   '), { location: null, country: null });
  assert.deepEqual(normalizeJobBoardLocation(null), { location: null, country: null });
  assert.deepEqual(normalizeJobBoardLocation(undefined), { location: null, country: null });
});

test('matching is case-insensitive and trims surrounding whitespace', () => {
  assert.deepEqual(normalizeJobBoardLocation('  nederland  '), { location: 'Netherlands', country: 'netherlands' });
  assert.deepEqual(normalizeJobBoardLocation('NEDERLAND'), { location: 'Netherlands', country: 'netherlands' });
});

test('ts-jobspy\'s own English abbreviations (uk, usa, uae) are still recognized as countries, mapped to their full name', () => {
  assert.deepEqual(normalizeJobBoardLocation('uk'), { location: 'United Kingdom', country: 'united kingdom' });
  assert.deepEqual(normalizeJobBoardLocation('usa'), { location: 'United States', country: 'united states' });
});
