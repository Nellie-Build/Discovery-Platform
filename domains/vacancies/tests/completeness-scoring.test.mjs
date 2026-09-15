import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vacancyCompletenessScore } from '../dist/index.js';

function vacancy(overrides = {}) {
  return {
    title: null, company: null, location: null, salary: null, hours: null, contractType: null,
    description: null, contactPerson: null, phone: null, email: null, sourceUrl: 'https://example.com/vacatures/1',
    ...overrides,
  };
}

test('a complete vacancy (every signal present) scores 100', () => {
  const result = vacancyCompletenessScore(vacancy({
    title: 'Receptionist', company: 'Riad Zaytoun', location: 'Marrakech',
    description: 'Fulltime receptionist gezocht voor een boutique riad.',
    salary: '€1.800 - €2.200 per maand', email: 'jobs@riad-zaytoun.example',
  }));
  assert.equal(result.score, 100);
  assert.deepEqual(result.missingSignals, []);
});

test('a vacancy without salary loses exactly the salary points, nothing else', () => {
  const withSalary = vacancyCompletenessScore(vacancy({
    title: 'Receptionist', company: 'Riad Zaytoun', location: 'Marrakech',
    description: 'Fulltime receptionist gezocht.', salary: '€2.000 per maand', email: 'jobs@example.com',
  }));
  const withoutSalary = vacancyCompletenessScore(vacancy({
    title: 'Receptionist', company: 'Riad Zaytoun', location: 'Marrakech',
    description: 'Fulltime receptionist gezocht.', email: 'jobs@example.com',
  }));
  assert.equal(withSalary.score - withoutSalary.score, 10);
  assert.deepEqual(withoutSalary.missingSignals, ['salary']);
});

test('a vacancy without any direct contact (no phone/email/contactPerson) is missing that signal only', () => {
  const result = vacancyCompletenessScore(vacancy({
    title: 'Tuinman', company: 'Villa Amira', location: 'Agadir', description: 'Onderhoud van de tuin.',
  }));
  assert.ok(result.missingSignals.includes('directContact'));
  assert.ok(!result.missingSignals.includes('title'));
});

test('a very minimal page (title only) scores low and is missing every other signal', () => {
  const result = vacancyCompletenessScore(vacancy({ title: 'Vacature', sourceUrl: null }));
  assert.equal(result.score, 20);
  assert.deepEqual(result.presentSignals, ['title']);
  assert.deepEqual(result.missingSignals, ['company', 'location', 'description', 'salary', 'directContact', 'sourceUrl']);
});

test('a completely empty vacancy scores 0', () => {
  const result = vacancyCompletenessScore(vacancy({ sourceUrl: null }));
  assert.equal(result.score, 0);
  assert.deepEqual(result.presentSignals, []);
});

test('uses the same generic engine any other domain module would, with rules unrelated to any other domain (page completeness, not business type)', () => {
  const result = vacancyCompletenessScore(vacancy({ title: 'Kok', company: 'Restaurant Atlas' }));
  // No hotel/WhatsApp/private-rental vocabulary anywhere near this result — a different domain,
  // same engine.
  assert.ok(!('businessType' in result));
  assert.ok(!('whatsappConfirmed' in result));
});
