import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { extractContacts } from '@discovery-platform/core';
import { extractVacancyWithDiagnostic } from '../dist/extract-vacancy.js';

/**
 * A page about a profession or field ("Working as a nurse") is not a vacancy, however long its text is and
 * however much contact information it has. Without JobPosting data, text + a contact only counts as a
 * vacancy when something also points to ONE opportunity: explicit employment metadata, a person named for
 * it, or a real application action. Shapes below reproduce what career sites publish; nothing is tied to a
 * site, a URL or a profession.
 */
const normalizers = {
  normalizePhone: raw => { const d = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, ''); return /^\+?\d{8,15}$/.test(d) ? d : null; },
  normalizeEmail: raw => { const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null; },
};
function run(html, url = 'https://careers.example/some-page') {
  const $ = load(html);
  const page = { $, url, isHomepage: false, priority: 10, contacts: extractContacts($, new URL(url).hostname, normalizers) };
  const { facts, diagnostic } = extractVacancyWithDiagnostic(page);
  return { facts: facts?.[0], diagnostic };
}
const prose = n => Array.from({ length: n }, (_, i) => `<p>Paragraaf ${i + 1}: in dit vakgebied werk je samen met collega's aan zorg, ontwikkeling en kwaliteit. Je krijgt de ruimte om te groeien, volgt opleidingen en werkt in een team dat elkaar helpt. Lees hieronder meer over wat je kunt verwachten.</p>`).join('\n');
const englishProse = n => Array.from({ length: n }, (_, i) => `<p>Section ${i + 1}: people in this field work closely with colleagues on care, development and quality. You get room to grow, take part in training and join a team that supports each other. Read on to find out more about what to expect.</p>`).join('\n');

// ─── the drawn-out shape of the three live false positives ─────────────────────────────────────────

test('A: a profession page with a long description and a general mailbox, no JobPosting, is not a vacancy', () => {
  const { diagnostic } = run(`<html><head><title>Werken als verpleegkundige bij Voorbeeld</title></head><body><main>
    <h2>Werken als verpleegkundige bij Voorbeeld</h2>${prose(20)}
    <h2>Nog aan het oriënteren?</h2><p>Stuur ons een e-mail op: <a href="mailto:werken@voorbeeld.example">werken@voorbeeld.example</a></p></main></body></html>`);
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
  assert.equal(diagnostic.descriptionFound, true);
  assert.equal(diagnostic.directContactFound, true);
  assert.ok(diagnostic.signalScore >= 3, 'the score alone would have accepted it');
});

test('B: a field page that links to several vacancies with "view vacancy" links is not a vacancy either', () => {
  const { diagnostic } = run(`<html><head><title>Werken bij Voorbeeld als arts</title></head><body><main>
    <h2>Werken bij Voorbeeld als arts</h2>${prose(18)}
    <h2>Actuele vacatures</h2>
    <div><a href="/o/arts-a">Arts A</a> <a href="/o/arts-a">Bekijk vacature</a></div><div><a href="/o/arts-b">Arts B</a> <a href="/o/arts-b">Bekijk vacature</a></div>
    <p>Stuur ons een e-mail op: <a href="mailto:werken@voorbeeld.example">werken@voorbeeld.example</a></p></main></body></html>`);
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
  assert.equal(diagnostic.signalScore >= 6, true, 'even with the "view vacancy" call to action counted in the score');
});

test('C: the same with a psychologist-style page: a question mailbox and no application action', () => {
  const { diagnostic } = run(`<html><head><title>Werken als psycholoog bij Voorbeeld</title></head><body><main>
    <h2>Werken als psycholoog bij Voorbeeld</h2>${prose(13)}
    <p>Ben je psycholoog en zoekende of ons werk bij je past? Stel je vraag aan ons via: <a href="mailto:werken@voorbeeld.example">werken@voorbeeld.example</a></p></main></body></html>`);
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
});

// ─── generic career content, in another language and with other contact shapes ─────────────────────────

test('generic negative: "Working as a nurse" with 1000+ characters, a general phone number and a "View vacancies" call to action', () => {
  const { diagnostic } = run(`<html><head><title>Working as a nurse</title></head><body><main>
    <h1>Working as a nurse</h1>${englishProse(6)}
    <p>Questions? Call us on <a href="tel:+31201234567">+31 20 123 4567</a>.</p><a href="/vacancies">View vacancies</a></main></body></html>`);
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
});

test('generic negative: "Careers in engineering" with "full-time / part-time" in running text and general contact details', () => {
  const { facts, diagnostic } = run(`<html><head><title>Careers in engineering</title></head><body><main>
    <h1>Careers in engineering</h1>
    <p>Engineers with us work full-time or part-time, typically 32 to 40 hours per week, on projects for clients all over the country. Whatever your background, there is a route into engineering.</p>
    ${englishProse(5)}
    <p>General enquiries: <a href="mailto:careers@engineering.example">careers@engineering.example</a> or <a href="tel:+31307654321">+31 30 765 4321</a></p></main></body></html>`);
  assert.equal(facts?.hours ?? null, null, 'unlabelled prose is not employment metadata');
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
});

// ─── what must keep working ─────────────────────────────────────────────────────────────────────

test('a JobPosting JSON-LD page is a vacancy, however little else it has', () => {
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Ergotherapeut', hiringOrganization: { '@type': 'Organization', name: 'Voorbeeld' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Den Haag' } }, employmentType: 'PART_TIME', description: '<p>Werken als ergotherapeut.</p>' });
  const { facts, diagnostic } = run(`<html><head><title>Ergotherapeut</title><script type="application/ld+json">${jsonLd}</script></head><body><main><h1>Ergotherapeut</h1></main></body></html>`, 'https://careers.example/o/ergotherapeut-3');
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.detailEvidence, 'json_ld');
  assert.equal(facts.company, 'Voorbeeld');
});

test('a real vacancy without JSON-LD and without a company is accepted on its employment metadata', () => {
  const { diagnostic } = run(`<html><head><title>Beleidsadviseur - Werken bij</title></head><body><main>
    <h1>Beleidsadviseur</h1>
    <dl><dt>Locatie</dt><dd>Utrecht</dd><dt>Uren</dt><dd>32 - 36 uur per week</dd><dt>Salaris</dt><dd>€ 3.800 - € 5.200</dd></dl>
    ${prose(3)}</main></body></html>`, 'https://careers.example/vacatures/beleidsadviseur');
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.detailEvidence, 'metadata');
  assert.ok(diagnostic.metadataFieldsFound >= 3);
});

test('without metadata, description + contact is still enough when a person is named for the opportunity', () => {
  const { diagnostic } = run(`<html><head><title>Vacature - Acme</title></head><body><h1>Beleidsmedewerker</h1><main>${prose(2)}</main>
    <p>Contactpersoon: Petra Smit</p><a href="mailto:petra.smit@acme.example">Mail Petra</a></body></html>`, 'https://acme.example/vacatures/beleidsmedewerker');
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.detailEvidence, 'contact_person');
});

test('without metadata, description + contact is still enough when the page offers an actual application action', () => {
  const { diagnostic } = run(`<html><head><title>Kok - Voorbeeld</title></head><body><main><h1>Kok</h1>${prose(3)}
    <p>Vragen? Mail <a href="mailto:hr@voorbeeld.example">hr@voorbeeld.example</a></p><a href="/solliciteren/kok">Solliciteer nu</a></main></body></html>`, 'https://voorbeeld.example/vacatures/kok');
  assert.equal(diagnostic.accepted, true);
  assert.equal(diagnostic.detailEvidence, 'apply_action');
});

test('a "view vacancy" link is navigation to another vacancy, not an application action', () => {
  const { diagnostic } = run(`<html><head><title>Kok - Voorbeeld</title></head><body><main><h1>Kok</h1>${prose(3)}
    <p>Vragen? Mail <a href="mailto:hr@voorbeeld.example">hr@voorbeeld.example</a></p><a href="/o/andere">Bekijk vacature</a></main></body></html>`, 'https://voorbeeld.example/vacatures/kok');
  assert.equal(diagnostic.accepted, false);
  assert.equal(diagnostic.rejectionReason, 'no_single_vacancy_evidence');
});

test('the failure reasons stay distinguishable: no description/contact route vs. no single-vacancy evidence', () => {
  assert.equal(run('<html><head><title>Kok</title></head><body><main><h1>Kok</h1><p>Kort.</p></main></body></html>').diagnostic.rejectionReason, 'insufficient_description');
});
