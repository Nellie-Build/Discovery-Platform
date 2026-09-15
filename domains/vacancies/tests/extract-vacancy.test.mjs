import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { extractContacts } from '@discovery-platform/core';
import { extractVacancy } from '../dist/extract-vacancy.js';

// Deliberately simple and country-agnostic — this domain package owns no phone-numbering-plan
// knowledge of its own — that logic lives in
// whichever application wires a domain into a real crawl; see examples/vacancy-discovery).
const normalizers = {
  normalizePhone(raw) {
    const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{8,15}$/.test(digits)) return '+' + digits;
    return null;
  },
  normalizeEmail(raw) {
    const email = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
  },
};

async function loadPage(fixture, url) {
  const html = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  const $ = load(html);
  const contacts = extractContacts($, new URL(url).hostname, normalizers);
  return { $, url, isHomepage: false, priority: 10, contacts };
}

// ─── A: JSON-LD JobPosting ──────────────────────────────────────────────────────────────────
test('A: a JobPosting JSON-LD page yields title, company, location, salary and employmentType', async () => {
  const page = await loadPage('job-with-jsonld.html', 'https://acme-software.example/vacatures/frontend-developer');
  const results = extractVacancy(page);
  assert.equal(results.length, 1);
  const [facts] = results;
  assert.equal(facts.title, 'Frontend Developer');
  assert.equal(facts.company, 'Acme Software');
  assert.equal(facts.location, 'Utrecht');
  assert.equal(facts.salary, 'EUR 3200-4100 MONTH');
  assert.equal(facts.contractType, 'FULL_TIME');
  assert.ok(facts.description.includes('Frontend Developer'));
  assert.ok(!facts.description.includes('<b>'), 'HTML tags must be stripped from the description');
  assert.equal(facts.sourceUrl, page.url);
});

// ─── B: a vacancy without JSON-LD ───────────────────────────────────────────────────────────
test('B: a vacancy without JSON-LD is still recognized from reliable HTML/text labels, never guessed beyond them', async () => {
  const page = await loadPage('job-without-jsonld.html', 'https://example-logistics.test/vacatures/magazijnmedewerker');
  const results = extractVacancy(page);
  assert.equal(results.length, 1);
  const [facts] = results;
  assert.equal(facts.title, 'Vacature: Magazijnmedewerker'); // from <title>, no JSON-LD available
  assert.equal(facts.location, 'Rotterdam');
  assert.equal(facts.salary, '€2.600 - €2.900 per maand');
  assert.equal(facts.hours, '32-40 uur');
  assert.equal(facts.contractType, 'vast dienstverband');
  assert.equal(facts.contactPerson, 'Sanne de Vries');
  // Nothing in the fixture ever states a company name — never invented.
  assert.equal(facts.company, null);
  assert.equal(facts.description, null); // description is only ever taken from real JSON-LD
});

// ─── C: contact details reuse discovery-core's own extractContacts ─────────────────────────
test('C: contact details are @discovery-platform/core\'s own extractContacts output, not a separate implementation', async () => {
  const page = await loadPage('job-without-jsonld.html', 'https://example-logistics.test/vacatures/magazijnmedewerker');
  const expectedContacts = extractContacts(page.$, 'example-logistics.test', normalizers);
  assert.deepEqual(page.contacts, expectedContacts);
  assert.ok(expectedContacts.email, 'the fixture has a real mailto: link');
  assert.ok(expectedContacts.phone, 'the fixture has a real tel: link');
  const [facts] = extractVacancy(page);
  assert.equal(facts.email, expectedContacts.email);
  assert.equal(facts.phone, expectedContacts.phone);
});

test('a page with only a generic title and nothing vacancy-specific is never reported as a vacancy', async () => {
  const $ = load('<html><head><title>Over ons</title></head><body><p>Wij zijn een modern bedrijf.</p></body></html>');
  const page = { $, url: 'https://example-logistics.test/over-ons', isHomepage: false, priority: 10,
    contacts: extractContacts($, 'example-logistics.test', normalizers) };
  assert.equal(extractVacancy(page), undefined);
});
