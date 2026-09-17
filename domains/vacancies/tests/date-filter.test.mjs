import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWithinPostedWindow } from '../dist/date-filter.js';

const NOW = new Date('2026-09-17T12:00:00Z');

test('no postedWithinDays at all means every vacancy passes, regardless of postedDate', () => {
  assert.equal(isWithinPostedWindow({ postedDate: '2020-01-01' }, {}, NOW), true);
  assert.equal(isWithinPostedWindow({ postedDate: null }, {}, NOW), true);
});

test('a vacancy posted within the window passes', () => {
  assert.equal(isWithinPostedWindow({ postedDate: '2026-09-15' }, { postedWithinDays: 7 }, NOW), true);
});

test('a vacancy posted comfortably within a wider window still passes', () => {
  assert.equal(isWithinPostedWindow({ postedDate: '2026-09-09' }, { postedWithinDays: 14 }, NOW), true);
});

test('a vacancy posted outside the window is rejected', () => {
  assert.equal(isWithinPostedWindow({ postedDate: '2026-09-01' }, { postedWithinDays: 7 }, NOW), false);
});

test('an unknown postedDate is kept by default — never auto-rejected just because the date is missing', () => {
  assert.equal(isWithinPostedWindow({ postedDate: null }, { postedWithinDays: 7 }, NOW), true);
});

test('rejectUnknownDate: true makes an unknown postedDate fail the filter instead', () => {
  assert.equal(isWithinPostedWindow({ postedDate: null }, { postedWithinDays: 7, rejectUnknownDate: true }, NOW), false);
});

test('a malformed postedDate string is treated the same as unknown — never a guess, never a crash', () => {
  assert.equal(isWithinPostedWindow({ postedDate: 'not-a-date' }, { postedWithinDays: 7 }, NOW), true);
  assert.equal(isWithinPostedWindow({ postedDate: 'not-a-date' }, { postedWithinDays: 7, rejectUnknownDate: true }, NOW), false);
});

test('postedWithinDays: 0 or a negative value disables the filter entirely, same as omitting it', () => {
  assert.equal(isWithinPostedWindow({ postedDate: '2000-01-01' }, { postedWithinDays: 0 }, NOW), true);
  assert.equal(isWithinPostedWindow({ postedDate: '2000-01-01' }, { postedWithinDays: -5 }, NOW), true);
});
