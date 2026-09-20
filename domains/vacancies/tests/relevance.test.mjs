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
  // "Projectleider" also matches "project" as the start of a compound word.
  assert.deepEqual(result.matchedTerms, ['security', 'project']);
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
    vacancy({ title: 'Allround medewerker', description: 'Je werkt samen met het security team aan security en toegangsbeheer.' }),
    { branch: 'Security' },
  );
  assert.equal(result.accepted, true);
  assert.equal(result.acceptanceReason, 'description_content_match');
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

test('no usable branch/keywords cannot establish relevance', () => {
  const result = scoreVacancyRelevance(vacancy({ title: 'Anything' }), { branch: '   ', keywords: null });
  assert.equal(result.accepted, false);
  assert.equal(result.score, 0);
});

const filler = (n) => Array.from({ length: n }, (_, i) => `woord${i}`).join(' ');
const ONDERWIJS = { branch: 'Onderwijs', keywords: 'zuid-holland', region: 'Nederland' };
const SECURITY = { branch: 'Security', keywords: 'security officer beveiliging', region: 'Nederland' };

test('Onderwijs + zuid-holland: education vacancies in Zuid-Holland are accepted on their content', () => {
  const teacher = scoreVacancyRelevance(vacancy({ title: 'Leerkracht groep 6', company: 'Stichting BOOR', location: 'Rotterdam, ZH, NL',
    description: `Onderwijs in Zuid-Holland. Je geeft onderwijs aan groep 6. ${filler(60)}` }), ONDERWIJS);
  assert.equal(teacher.accepted, true);
  assert.equal(teacher.acceptanceReason, 'description_content_match');
  const assistant = scoreVacancyRelevance(vacancy({ title: 'Onderwijsassistent praktijkonderwijs', location: 'Den Haag' }), ONDERWIJS);
  assert.equal(assistant.accepted, true);
  assert.equal(assistant.acceptanceReason, 'title_branch_match');
  const docent = scoreVacancyRelevance(vacancy({ title: 'Docent Nederlands', company: 'Dunamare onderwijsgroep', description: 'Het onderwijs op onze school. Goed onderwijs voor iedereen. ' + filler(40) }), ONDERWIJS);
  assert.equal(docent.accepted, true);
});

test('Onderwijs + zuid-holland: unrelated jobs are rejected even though "Zuid-Holland" and "onderwijs" appear in their text', () => {
  for (const title of ['Timmerman', 'Betontimmerman', 'Walsmachinist', 'Schoonmaak medewerker', 'Receptionist(e)']) {
    const result = scoreVacancyRelevance(vacancy({ title, company: 'KWS Infra', location: 'Zwijndrecht, ZH, NL',
      description: `${filler(200)} Rijswijk, Zuid-Holland. Middelbaar onderwijs afgerond. ${filler(200)}` }), ONDERWIJS);
    assert.equal(result.accepted, false, title);
    assert.equal(result.contentMatch, false, title);
    assert.match(result.acceptanceReason, /^rejected_/, title);
  }
});

test('a location match alone, or a region word in the description alone, never accepts', () => {
  const locationOnly = scoreVacancyRelevance(vacancy({ title: 'Timmerman', location: 'Zuid-Holland, Nederland', description: 'Werken in Zuid-Holland.' }),
    { branch: 'Onderwijs', keywords: 'zuid-holland', region: 'Zuid-Holland' });
  assert.equal(locationOnly.accepted, false);
  assert.equal(locationOnly.locationMatch, true);
  assert.equal(locationOnly.acceptanceReason, 'rejected_location_only');
  assert.deepEqual(locationOnly.matchedTerms.sort(), ['holland', 'zuid']);
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'Timmerman', description: 'Zuid-Holland' }), { branch: 'Zuid-Holland' }).accepted, true, 'a branch the user typed is still content');
});

test('a hyphenated keyword is kept as a phrase and as parts, but only content decides', () => {
  const inTitle = scoreVacancyRelevance(vacancy({ title: 'Docent Wiskunde Zuid-Holland', description: filler(50) }), { branch: 'Onderwijs', keywords: 'zuid-holland' });
  assert.equal(inTitle.accepted, false);
  assert.deepEqual(inTitle.titleMatches.sort(), ['holland', 'zuid']);
  assert.equal(inTitle.phraseMatches.length, 0);
});

test('a docent outside the region is still classified on content, not on the location', () => {
  const docent = scoreVacancyRelevance(vacancy({ title: 'Docent Onderwijs', location: 'Groningen' }), ONDERWIJS);
  assert.equal(docent.accepted, true);
  assert.equal(docent.locationMatch, false);
});

test('Security + Nederland: security roles are accepted, look-alike "officer" roles without security context are not', () => {
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'Security Officer' }), SECURITY).accepted, true);
  const engineer = scoreVacancyRelevance(vacancy({ title: 'IT Security Engineer', description: filler(30) }), SECURITY);
  assert.equal(engineer.accepted, true);
  assert.equal(engineer.acceptanceReason, 'title_branch_match');
  for (const title of ['Facility Officer', 'Driver Desk Officer']) {
    const result = scoreVacancyRelevance(vacancy({ title, company: 'Logistics', description: `${filler(100)} veilig werken` }), SECURITY);
    assert.equal(result.accepted, false, title);
    assert.deepEqual(result.titleMatches, ['officer'], title);
  }
});

test('a company name alone ("Security Group") does not accept a vacancy without relevant content', () => {
  const sales = scoreVacancyRelevance(vacancy({ title: 'Sales Manager', company: 'Eye Watch Security Group', description: filler(80) }), SECURITY);
  assert.equal(sales.accepted, false);
  assert.deepEqual(sales.companyMatches, ['security']);
  const withContext = scoreVacancyRelevance(vacancy({ title: 'Centralist Meldkamer', company: 'Eye Watch Security Group', description: 'Toezicht op alarm en beveiliging. ' + filler(40) }), SECURITY);
  assert.equal(withContext.accepted, true);
});

test('a typed phrase in the title is accepted and scores higher than its loose words', () => {
  const phrase = scoreVacancyRelevance(vacancy({ title: 'Senior Project Manager Bouw' }), { branch: 'Bouw', keywords: 'project manager' });
  const loose = scoreVacancyRelevance(vacancy({ title: 'Manager Bouw en Project' }), { branch: 'Bouw', keywords: 'project manager' });
  assert.deepEqual(phrase.phraseMatches, ['project manager']);
  assert.ok(phrase.score > loose.score);
  const onlyPhrase = scoreVacancyRelevance(vacancy({ title: 'Maatschappelijk werker jeugd' }), { branch: 'Zorg', keywords: 'maatschappelijk werker' });
  assert.equal(onlyPhrase.accepted, true);
  assert.equal(onlyPhrase.acceptanceReason, 'keyword_phrase_match');
});

test('words of the same family and compounds match, but never a suffix', () => {
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'Beveiliger winkels' }), { branch: 'Zorg', keywords: 'beveiliging' }).accepted, true);
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'Onderwijsassistent' }), { branch: 'Onderwijs' }).accepted, true);
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'Cybersecurity Analyst' }), { branch: 'Security' }).accepted, false);
});

test('diagnostics explain every decision', () => {
  const accepted = scoreVacancyRelevance(vacancy({ title: 'Security Officer', company: 'Acme', location: 'Utrecht' }), { ...SECURITY, region: 'Utrecht' });
  for (const key of ['matchedTerms', 'titleMatches', 'descriptionMatches', 'companyMatches', 'phraseMatches', 'locationMatch', 'relevanceScore', 'contentMatch', 'acceptanceReason']) assert.ok(key in accepted, key);
  assert.equal(accepted.contentMatch, true);
  assert.equal(accepted.locationMatch, true);
  const rejected = scoreVacancyRelevance(vacancy({ title: 'HR Generalist' }), SECURITY);
  assert.equal(rejected.acceptanceReason, 'rejected_no_match');
  assert.equal(scoreVacancyRelevance(vacancy({ title: 'x' }), { branch: '  ' }).acceptanceReason, 'rejected_no_query_terms');
});
