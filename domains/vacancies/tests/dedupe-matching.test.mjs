import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findVacancyDuplicates } from '../dist/index.js';

function vacancy(overrides = {}) {
  return {
    title: null, company: null, location: null, salary: null, hours: null, contractType: null,
    description: null, contactPerson: null, phone: null, email: null, sourceUrl: 'https://example.com/vacatures/1',
    ...overrides,
  };
}

test('identical source URL is a duplicate', () => {
  const a = vacancy({ sourceUrl: 'https://example.com/vacatures/1', title: 'Receptionist' });
  const b = vacancy({ sourceUrl: 'https://example.com/vacatures/1', title: 'Receptionist (re-crawled)' });
  const [candidate] = findVacancyDuplicates([a, b]);
  assert.ok(candidate);
  assert.equal(candidate.decision, 'duplicate');
  assert.ok(candidate.matchedSignals.includes('sourceUrl'));
});

test('same company, normalized title and location is a duplicate (or at least a strong match)', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/jobs/1', company: 'Riad Zaytoun', title: 'Receptionist', location: 'Marrakech' });
  const b = vacancy({ sourceUrl: 'https://a.example.com/jobs/1?utm=x', company: 'RIAD ZAYTOUN', title: '  receptionist  ', location: 'marrakech' });
  const [candidate] = findVacancyDuplicates([a, b]);
  assert.ok(candidate);
  assert.ok(['duplicate', 'possible_duplicate'].includes(candidate.decision));
  assert.ok(candidate.matchedSignals.includes('companyTitleLocation'));
});

test('same title but a different company is never a duplicate', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/1', company: 'Riad Zaytoun', title: 'Receptionist', location: 'Marrakech' });
  const b = vacancy({ sourceUrl: 'https://b.example.com/1', company: 'Hotel Atlas', title: 'Receptionist', location: 'Marrakech' });
  assert.deepEqual(findVacancyDuplicates([a, b]), []);
});

test('same company but a different function is never flagged for merge', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/1', company: 'Riad Zaytoun', title: 'Receptionist', location: 'Marrakech' });
  const b = vacancy({ sourceUrl: 'https://a.example.com/2', company: 'Riad Zaytoun', title: 'Tuinman', location: 'Marrakech' });
  assert.deepEqual(findVacancyDuplicates([a, b]), []);
});

test('the same vacancy reached via two different page URLs, with company+title+location matching, is flagged per the chosen config', () => {
  const a = vacancy({ sourceUrl: 'https://example.com/vacatures/receptionist-marrakech', company: 'Riad Zaytoun', title: 'Receptionist', location: 'Marrakech' });
  const b = vacancy({ sourceUrl: 'https://jobboard.example.com/listing/98213', company: 'Riad Zaytoun', title: 'Receptionist', location: 'Marrakech' });
  const [candidate] = findVacancyDuplicates([a, b]);
  assert.ok(candidate);
  assert.ok(!candidate.matchedSignals.includes('sourceUrl'));
  assert.ok(['duplicate', 'possible_duplicate'].includes(candidate.decision));
});

test('same company and title but no location at all is only a weaker possible_duplicate, not an outright duplicate', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/1', company: 'Riad Zaytoun', title: 'Receptionist' });
  const b = vacancy({ sourceUrl: 'https://b.example.com/1', company: 'Riad Zaytoun', title: 'Receptionist' });
  const [candidate] = findVacancyDuplicates([a, b]);
  assert.ok(candidate);
  assert.equal(candidate.decision, 'possible_duplicate');
  assert.deepEqual(candidate.matchedSignals, ['companyTitle']);
});

test('title or location alone is deliberately never a signal — unrelated vacancies in the same city never match', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/1', title: 'Receptionist', location: 'Marrakech' });
  const b = vacancy({ sourceUrl: 'https://b.example.com/1', title: 'Receptionist', location: 'Marrakech' });
  assert.deepEqual(findVacancyDuplicates([a, b]), []);
});

test('a very minimal vacancy (title only) never matches anything', () => {
  const a = vacancy({ sourceUrl: 'https://a.example.com/1', title: 'Vacature' });
  const b = vacancy({ sourceUrl: 'https://b.example.com/1', title: 'Vacature' });
  assert.deepEqual(findVacancyDuplicates([a, b]), []);
});
