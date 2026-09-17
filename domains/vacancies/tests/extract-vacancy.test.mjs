import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { extractContacts } from '@discovery-platform/core';
import { extractVacancy } from '../dist/extract-vacancy.js';

// Deliberately simple and country-agnostic — this domain package owns no phone-numbering-plan
// knowledge of its own — that logic lives in
// whichever application wires a domain into a real crawl; see examples/vacancy-discovery).
// A number that already spells out its own country code (a leading `+`) is normalized as
// international. A local number with no `+` stays local — never invent a country code.
const normalizers = {
  normalizePhone(raw) {
    const digits = raw.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{8,15}$/.test(digits)) return digits;
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

function pageFromHtml(html, url) {
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
  // The fixture's tel: link already spells out its own country code — kept as-is.
  assert.equal(facts.phone, '+31201234567');
});

// ─── A2: JobPosting nested inside @graph, with array-shaped hiringOrganization/jobLocation/employmentType ──
test('A2: a JobPosting nested in @graph, with hiringOrganization/jobLocation/employmentType all given as arrays, is read in full and multiple locations are combined without duplicates', async () => {
  const page = await loadPage('job-graph-multi.html', 'https://acme-analytics.example/vacatures/data-analyst');
  const results = extractVacancy(page);
  assert.equal(results.length, 1);
  const [facts] = results;
  assert.equal(facts.title, 'Data Analyst');
  assert.equal(facts.company, 'Acme Analytics BV');
  assert.equal(facts.location, 'Amsterdam, Noord-Holland; Rotterdam, Zuid-Holland');
  assert.equal(facts.contractType, 'FULL_TIME, PART_TIME');
  assert.equal(facts.description, 'Data Analyst gezocht bij Acme Analytics.');
});

// ─── B: a vacancy without JSON-LD ───────────────────────────────────────────────────────────
test('B: a vacancy without JSON-LD is still recognized from reliable HTML/text labels, never guessed beyond them', async () => {
  const page = await loadPage('job-without-jsonld.html', 'https://example-logistics.test/vacatures/magazijnmedewerker');
  const results = extractVacancy(page);
  assert.equal(results.length, 1);
  const [facts] = results;
  // No JSON-LD and no itemprop="title" on this fixture, so the <title> tag wins over the <h1> —
  // see the dedicated title-priority tests below for why a bare <h1> is only a last resort.
  assert.equal(facts.title, 'Vacature: Magazijnmedewerker');
  assert.equal(facts.location, 'Rotterdam');
  assert.equal(facts.salary, '€2.600 - €2.900 per maand');
  assert.equal(facts.hours, '32-40 uur');
  assert.equal(facts.contractType, 'vast dienstverband');
  assert.equal(facts.contactPerson, 'Sanne de Vries');
  // Nothing in the fixture ever states a company name — never invented.
  assert.equal(facts.company, null);
  assert.equal(facts.description, null); // description is only ever taken from real JSON-LD or an explicit itemprop block
  // The fixture's tel: link is a local number with no country code — it must stay local, never
  // gain an invented leading "+".
  assert.equal(facts.phone, '0201234567');
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

// ─── D: generic DOM label/value fallback — dt/dd, table th/td, and a label element followed by its sibling ──
test('D: a vacancy with no JSON-LD and no inline "Label: value" text is still recognized from dt/dd, table th/td, and label-element/sibling DOM pairs', async () => {
  const page = await loadPage('job-dom-labels.html', 'https://voorbeeldbedrijf.example/vacatures/financieel-medewerker');
  const results = extractVacancy(page);
  assert.equal(results.length, 1);
  const [facts] = results;
  assert.equal(facts.title, 'Vacature: Financieel Medewerker - Werken bij Voorbeeldbedrijf'); // <title> tag, no better source available
  assert.equal(facts.location, 'Eindhoven'); // <dt>Locatie</dt><dd>Eindhoven</dd>
  assert.equal(facts.hours, '36 uur per week'); // <dt>Uren</dt><dd>...</dd>
  assert.equal(facts.salary, '€3.000 - €3.500 per maand'); // <th>Salaris</th><td>...</td>
  assert.equal(facts.company, 'Acme Analytics BV'); // <strong>Werkgever</strong> <span>...</span>
  assert.equal(facts.contactPerson, 'Julia de Boer'); // two neighboring <div>s, no colon at all
  // Nothing in this fixture states a phone, e-mail or description — never guessed.
  assert.equal(facts.phone, null);
  assert.equal(facts.email, null);
  assert.equal(facts.description, null);
});

test('a page with only a generic title and nothing vacancy-specific is never reported as a vacancy', async () => {
  const $ = load('<html><head><title>Over ons</title></head><body><p>Wij zijn een modern bedrijf.</p></body></html>');
  const page = { $, url: 'https://example-logistics.test/over-ons', isHomepage: false, priority: 10,
    contacts: extractContacts($, 'example-logistics.test', normalizers) };
  assert.equal(extractVacancy(page), undefined);
});

test('a label element with no adjacent value, and a bare mention of a label word in running prose, never produce a false value', () => {
  const page = pageFromHtml(
    '<html><head><title>Vacature: Consultant</title></head><body>\n' +
    '<h1>Consultant</h1>\n' +
    '<p>Reizen naar de locatie van de klant behoort tot de functie.</p>\n' + // "locatie" appears, but never as a standalone label
    '<dl><dt>Locatie</dt></dl>\n' + // a dt with no following dd at all
    '<p>Salaris: €3.000 per maand</p>\n' + // a genuine, separate signal so this page still qualifies as a vacancy
    '<p>Contactpersoon: Anna Jansen</p>\n' +
    '</body></html>',
    'https://example.test/vacatures/consultant',
  );
  const [facts] = extractVacancy(page);
  assert.equal(facts.location, null);
  assert.equal(facts.salary, '€3.000 per maand');
  assert.equal(facts.contactPerson, 'Anna Jansen');
});

// ─── Title priority regression: a real production incident on werkenbijdeoverheid.nl, where a
// site-wide header <h1> ("Werken bij de Overheid") was picked up as the job title instead of the
// actual function heading. Fixed by ranking <title> above a bare <h1>, and by rejecting any
// heading that matches the page's own og:site_name meta tag or a delimiter-separated segment of
// its own <title> — never a hardcoded site name or domain check. ──────────────────────────────

test('a generic/site-wide <h1> (matching the page\'s own og:site_name) is never chosen as the title when there is no better source', async () => {
  const page = await loadPage('job-only-generic-h1.html', 'https://careersite.example/vacatures/data-engineer');
  const [facts] = extractVacancy(page);
  assert.equal(facts.title, null);
  assert.equal(facts.salary, '€3.500 - €4.200 per maand');
});

test('a usable, page-specific <h1> may still be used as a last resort when there is truly no better source (no JSON-LD, no itemprop="title", no <title> tag)', async () => {
  const page = await loadPage('job-usable-h1-fallback.html', 'https://careersite.example/vacatures/data-engineer');
  const [facts] = extractVacancy(page);
  // The first, generic <h1> ("CareerSite", matching og:site_name) is skipped in favor of the
  // second, page-specific one.
  assert.equal(facts.title, 'Data Engineer');
});

test('JobPosting JSON-LD title always wins, even alongside a site-wide <h1 itemprop="name"> that could otherwise be mistaken for it', async () => {
  const page = await loadPage('job-jsonld-generic-h1.html', 'https://careersite.example/vacatures/data-engineer');
  const [facts] = extractVacancy(page);
  assert.equal(facts.title, 'Data Engineer');
  assert.equal(facts.company, 'Acme BV');
});

// ─── Additional generic semantic patterns for company/location ─────────────────────────────

test('company and location are read from schema.org microdata (itemprop="hiringOrganization"/"name" and itemprop="jobLocation"/"addressLocality"/"addressRegion") when there is no JSON-LD', async () => {
  const page = await loadPage('job-microdata.html', 'https://cloudcorp.example/vacatures/cloud-engineer');
  const [facts] = extractVacancy(page);
  assert.equal(facts.company, 'CloudCorp BV');
  assert.equal(facts.location, 'Groningen');
});

test('a bare, unscoped itemprop="name" (not nested inside hiringOrganization) is never read as the company — the same ambiguous property caused the title regression above', async () => {
  const page = await loadPage('job-bare-itemprop-name.html', 'https://example.test/vacatures/security-specialist');
  const [facts] = extractVacancy(page);
  assert.equal(facts.company, null);
  assert.equal(facts.salary, '€4.000 - €5.000 per maand');
});

test('location, hours, salary and contract type are read from an accessible-name attribute (aria-label/title) on an icon element paired with its sibling value — the real pattern werkenbijdeoverheid.nl itself uses', async () => {
  const page = await loadPage('job-aria-icons.html', 'https://www.werkenbijdeoverheid.nl/vacatures/platform-engineer');
  const [facts] = extractVacancy(page);
  assert.equal(facts.location, 'Apeldoorn');
  assert.equal(facts.hours, '32 - 36 uur');
  assert.equal(facts.salary, '€4.818 - €7.094 (bruto)');
  assert.equal(facts.contractType, 'Arbeidsovereenkomst voor bepaalde tijd');
  assert.equal(facts.phone, '0654764363');
});

// ─── False-positive regression: a real production incident on werkenbijdeoverheid.nl, where the
// vacancy overview page and the site's own careers landing page were both reported as vacancy
// records. Both pages embed *other* vacancies' own teaser widgets — the same location/salary/
// hours/contract-type accessible-icon pattern a real detail page uses for its own job — so that
// pattern alone is exactly as "rich-looking" on an overview page as on a real one. Fixed by
// requiring at least two independent signal groups (never just one) when there is no JobPosting
// JSON-LD — see `isPlausibleVacancyPage` in extract-vacancy.ts. ──────────────────────────────────

test('a vacancy overview page (several other vacancies\' own teaser widgets, no single subject of its own) is never reported as a vacancy record', async () => {
  const page = await loadPage('job-overview-page.html', 'https://careersite.example/vacatures');
  assert.equal(extractVacancy(page), undefined);
});

test('a careers landing page (a tagline plus a few teaser widgets for other vacancies) is never reported as a vacancy record', async () => {
  const page = await loadPage('job-landing-page.html', 'https://careersite.example/');
  assert.equal(extractVacancy(page), undefined);
});

test('a real vacancy detail page (job info plus a direct phone number, no JobPosting JSON-LD) still produces a record — the plausibility check does not cost genuine vacancies', async () => {
  const page = await loadPage('job-without-jsonld.html', 'https://example-logistics.test/vacatures/magazijnmedewerker');
  assert.notEqual(extractVacancy(page), undefined);
});

test('a page with only a title and a location — one single signal group — is rejected, never reported as a vacancy on that alone', async () => {
  const page = await loadPage('job-title-location-only.html', 'https://example.test/vacatures/onderzoeker');
  assert.equal(extractVacancy(page), undefined);
});

test('JobPosting JSON-LD alone is still accepted outright, with no other signal on the page at all — structured data never needs a second signal group', async () => {
  const page = await loadPage('job-jsonld-minimal.html', 'https://example.test/vacatures/minimal');
  const [facts] = extractVacancy(page);
  assert.equal(facts.title, 'Minimal Vacancy');
});

// ─── Generic metadata from repetitive/unlabeled structures — the real werkenbijspie.nl-shaped
// regression: a modern vacancy detail page with title/metadata/description/contact but no literal
// "Label: value" text and no itemprop="description" — reproduced with a minimal, generic fixture
// (never the real site's own HTML), see fixtures/job-metadata-block.html. ─────────────────────────

test('a real detail page shaped like this (title + unlabeled metadata block + DOM description + recruiter contact) is accepted', async () => {
  const page = await loadPage('job-metadata-block.html', 'https://acme-careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  const results = extractVacancy(page);
  assert.notEqual(results, undefined);
  assert.equal(results.length, 1);
});

test('location "Hengelo" is read from the structural metadata block via its data-field hint, with no literal "Locatie:" label anywhere', async () => {
  const page = await loadPage('job-metadata-block.html', 'https://acme-careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  const [facts] = extractVacancy(page);
  assert.equal(facts.location, 'Hengelo');
});

test('"40 uur" is recognized as hours purely by its own value shape, with no label at all', async () => {
  const page = await loadPage('job-metadata-block.html', 'https://acme-careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  const [facts] = extractVacancy(page);
  assert.equal(facts.hours, '40 uur');
});

test('a substantial description is recognized from main/article content even without itemprop="description"', async () => {
  const page = await loadPage('job-metadata-block.html', 'https://acme-careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  const [facts] = extractVacancy(page);
  assert.ok(facts.description && facts.description.length > 150);
  assert.ok(facts.description.includes('Tendermanager'));
  // Never leaks the surrounding page chrome (nav/header/apply link) into the description.
  assert.ok(!facts.description.includes('ACME Careers'));
  assert.ok(!facts.description.includes('Solliciteer'));
});

test('phone and e-mail keep working unchanged alongside the new metadata-block extraction', async () => {
  const page = await loadPage('job-metadata-block.html', 'https://acme-careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  const [facts] = extractVacancy(page);
  assert.equal(facts.phone, '0651361393');
  assert.equal(facts.email, 'jeroen.koster@acme-careers.example');
  assert.equal(facts.contactPerson, 'Jeroen Koster');
});

// ─── Real production regression: a vacancy *overview* page's own filter/facet sidebar (many
// short <label>/<li> checkbox options: "Vakgebied", "ICT", "Wo", "Hbo", ...) lives inside <main>
// too, right alongside one short instructional <p>. The DOM description fallback must never treat
// that sidebar as "the description" — it is not wrapped in <p> tags the way real authored prose
// is, unlike a genuine job description. Reproduced with a minimal fixture (never the real site's
// own HTML), see fixtures/job-overview-filter-panel.html. ─────────────────────────────────────────

test('a vacancy overview page whose <main> contains a filter/facet sidebar (many short <label>/<li> options, no real <p> prose) is never mistaken for a vacancy description', async () => {
  const page = await loadPage('job-overview-filter-panel.html', 'https://careersite.example/vacatures');
  assert.equal(extractVacancy(page), undefined);
});

// ─── Real production false positive: a company's own /contact staff page — a page title plus a
// named employee's own phone/e-mail, but nothing else job-specific at all — must never be
// mistaken for a vacancy just because "title + direct contact" alone reaches the score threshold.
test('a company contact/staff page (title + a named person\'s phone/e-mail, but no employment metadata and no description) is rejected, not saved as a vacancy', () => {
  const page = pageFromHtml(
    '<html><head><title>Contact - Acme</title><meta property="og:site_name" content="Acme"/></head><body>\n' +
    '<h1>Contact</h1>\n' +
    '<p>Neem contact op met Jan de Vries</p>\n' +
    '<a href="tel:0612345678">Bel Jan</a>\n' +
    '<a href="mailto:jan.devries@acme.example">Mail Jan</a>\n' +
    '</body></html>',
    'https://acme.example/contact',
  );
  assert.equal(extractVacancy(page), undefined);
});

test('a bare mention of an hours-shaped or contract-type-shaped value elsewhere on the page (not near the vacancy heading) is never picked up', async () => {
  const page = pageFromHtml(
    '<html><head><title>Vacature - ACME</title><meta property="og:site_name" content="ACME"/></head><body>\n' +
    '<h1>Consultant</h1>\n' +
    '<p>Salaris: €3.000 per maand</p>\n' +
    '<p>Contactpersoon: Anna Jansen</p>\n' +
    '<footer><p>Ons kantoor is 40 uur per week bereikbaar. Fulltime support.</p></footer>\n' +
    '</body></html>',
    'https://example.test/vacatures/consultant',
  );
  const [facts] = extractVacancy(page);
  assert.equal(facts.hours, null);
  assert.equal(facts.contractType, null);
});
