import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreVacancyRelevance } from '../dist/index.js';

function vacancy(overrides = {}) {
  return {
    title: null, company: null, location: null, salary: null, hours: null, contractType: null,
    description: null, contactPerson: null, phone: null, email: null, sourceUrl: 'https://example.com/vacatures/1',
    ...overrides,
  };
}

test('"Project Manager OT Cybersecurity" is accepted for branch=Security, keywords="Project Manager" (title evidence)', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Project Manager OT Cybersecurity' }), { branch: 'Security', keywords: 'Project Manager' });
  assert.equal(result.accepted, true);
  assert.ok(result.matchedTerms.includes('project'));
  assert.ok(result.matchedTerms.includes('manager'));
});

test('"Senior Project Manager Security" is accepted for branch=Security, keywords="Project Manager"', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Senior Project Manager Security' }), { branch: 'Security', keywords: 'Project Manager' });
  assert.equal(result.accepted, true);
});

test('"Projectleider security" is accepted (branch term "security" matches as its own word)', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Projectleider security' }), { branch: 'Security', keywords: 'Project Manager' });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.matchedTerms, ['security']);
});

test('"Projectmanager safety & security" is accepted', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Projectmanager safety & security' }), { branch: 'Security', keywords: 'Project Manager' });
  assert.equal(result.accepted, true);
});

test('"HR Generalist" with no relevant evidence anywhere is rejected', () => {
  const result = scoreVacancyRelevance(
    vacancy({ title: 'HR Generalist', description: 'Support the HR team with onboarding and payroll.', company: 'Acme HR' }),
    { branch: 'Security', keywords: 'Project Manager' },
  );
  assert.equal(result.accepted, false);
  assert.deepEqual(result.matchedTerms, []);
});

test('matching is case insensitive', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'SENIOR PROJECT MANAGER' }), { branch: 'security', keywords: 'project manager' });
  assert.equal(result.accepted, true);
});

test('punctuation around a match is handled correctly (word boundary, not a substring of a longer word)', () => {
  const accepted = scoreVacancyRelevance(vacancy({ title: 'Security-Officer (fulltime)' }), { branch: 'Security' });
  assert.equal(accepted.accepted, true);
  // "security" must never match inside "cybersecurity" as a substring — only as its own word.
  const rejected = scoreVacancyRelevance(vacancy({ title: 'Cybersecurity Analyst Trainee' }), { branch: 'Security', keywords: 'HR' });
  assert.equal(rejected.matchedTerms.includes('security'), false);
});

test('the description alone can supply supporting evidence when the title has none', () => {
  const result = scoreVacancyRelevance(
    vacancy({ title: 'Allround medewerker', description: 'Je werkt samen met het security team aan toegangsbeheer.' }),
    { branch: 'Security' },
  );
  assert.equal(result.accepted, true);
});

test('a title match weighs more than a description-only match', () => {
  const titleMatch = scoreVacancyRelevance(vacancy({ title: 'Security Officer' }), { branch: 'Security' });
  const descriptionMatch = scoreVacancyRelevance(vacancy({ title: 'Allround medewerker', description: 'security gerelateerd werk' }), { branch: 'Security' });
  assert.ok(titleMatch.score > descriptionMatch.score);
});

test('a vacancy is not required to contain every search word — one meaningful match is enough', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Beveiliger Security' }), { branch: 'Security', keywords: 'Project Manager Lead Architect' });
  assert.equal(result.accepted, true);
});

test('no branch/keywords at all is treated as no query to be relevant to (nothing to reject against)', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Anything' }), { branch: '   ', keywords: null });
  assert.equal(result.accepted, true);
  assert.equal(result.score, 0);
});
