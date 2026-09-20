import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { extractContacts } from '@discovery-platform/core';
import { extractVacancyWithDiagnostic } from '../dist/extract-vacancy.js';
import { assessCompanyName, chooseCompany, extractCompanyFromText, stripSentencePeriod } from '../dist/company.js';

/**
 * Who is the employer? The strongest source that names one wins, a weaker source never overrides it,
 * and when nothing reliable names an employer the company is null: a wrong name is worse than none.
 */
const normalizers = { normalizePhone: raw => raw.replace(/[^0-9+]/g, ''), normalizeEmail: raw => raw.toLowerCase() };

function extract(html, url = 'https://careers.example/vacatures/adviseur-1') {
  const $ = load(html);
  const page = { $, url, isHomepage: false, priority: 10, contacts: extractContacts($, new URL(url).hostname, normalizers) };
  const { facts, diagnostic } = extractVacancyWithDiagnostic(page);
  return { facts: facts?.[0], diagnostic };
}
/** A plausible vacancy detail page: title, location and hours, plus whatever employer signals a test adds. */
function vacancy({ title = 'Vacature: Adviseur', head = '', body = '' } = {}) {
  return `<html><head><title>${title}</title>${head}</head><body><main>
    <dl><dt>Locatie</dt><dd>Utrecht</dd><dt>Uren</dt><dd>36 uur per week</dd></dl>${body}</main></body></html>`;
}
const jobPosting = (name, extra = '') => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Adviseur', hiringOrganization: { '@type': 'Organization', name },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Utrecht' } } })}</script>${extra}`;

// ─── precedence: a weaker source never overrides a stronger one ──────────────────────────────

test('JobPosting JSON-LD hiringOrganization wins over every DOM, block and text signal, exactly as written', () => {
  const { facts, diagnostic } = extract(vacancy({
    title: 'Vacature: Adviseur, Andere Organisatie - Werken bij',
    head: jobPosting('Voorbeeld Organisatie'),
    body: '<dl><dt>Werkgever</dt><dd>Andere BV</dd></dl><h2>Over Andere Organisatie</h2><div class="employer-name">Derde BV</div>\nWerkgever: Vierde BV\n',
  }));
  assert.equal(facts.company, 'Voorbeeld Organisatie');
  assert.equal(diagnostic.companySource, 'json_ld');
});

test('microdata hiringOrganization wins over an explicit label, a block and a text fallback', () => {
  const { facts, diagnostic } = extract(vacancy({
    body: '<div itemprop="hiringOrganization" itemscope><span itemprop="name">CloudCorp BV</span></div><dl><dt>Werkgever</dt><dd>Label BV</dd></dl>\nWerkgever: Tekst BV\n',
  }));
  assert.equal(facts.company, 'CloudCorp BV');
  assert.equal(diagnostic.companySource, 'microdata');
});

test('an explicit label/value pair is read as written and wins over a block and running text', () => {
  const { facts, diagnostic } = extract(vacancy({ body: '<dl><dt>Werkgever</dt><dd>Stichting BOOR</dd></dl><div class="employer-name">Blok BV</div>\nWerkgever: Tekst BV\n' }));
  assert.equal(facts.company, 'Stichting BOOR');
  assert.equal(diagnostic.companySource, 'explicit_label');
  for (const label of ['Organisatie', 'Bedrijf', 'Employer', 'Company', 'Hiring organization']) {
    const result = extract(vacancy({ body: `<p><strong>${label}</strong> <span>Company &amp; Partners</span></p>` }));
    assert.equal(result.facts.company, 'Company & Partners', label);
    assert.equal(result.diagnostic.companySource, 'explicit_label', label);
  }
});

test('a name-specific employer element or itemprop="employer" is an organisation block, above running text', () => {
  const byClass = extract(vacancy({ body: '<div class="job-header__employer-name">  Hoogheemraadschap van   Delfland </div>\nWerkgever: Tekst BV\n' }));
  assert.equal(byClass.facts.company, 'Hoogheemraadschap van Delfland');
  assert.equal(byClass.diagnostic.companySource, 'organization_block');
  const byItemprop = extract(vacancy({ body: '<span itemprop="employer">TNO</span>' }));
  assert.equal(byItemprop.facts.company, 'TNO');
  assert.equal(byItemprop.diagnostic.companySource, 'organization_block');
});

test('an "Over <Name>" heading is the employer only when the page title names it too, and never a location or a generic section', () => {
  const confirmed = extract(vacancy({ title: 'Vacature: Adviseur, Rijkswaterstaat - Werken bij', body: '<h2>Over Rijkswaterstaat</h2><p>Wij zijn de uitvoeringsorganisatie.</p>' }));
  assert.equal(confirmed.facts.company, 'Rijkswaterstaat');
  assert.equal(confirmed.diagnostic.companySource, 'organization_block');
  const unconfirmed = extract(vacancy({ title: 'Vacature: Adviseur - Werken bij', body: '<h2>Over Rijkswaterstaat</h2>' }));
  assert.equal(unconfirmed.facts.company, null, 'the title does not name it: not enough evidence');
  const city = extract(vacancy({ title: 'Vacature: Adviseur in Utrecht - Werken bij', body: '<h2>Over Utrecht</h2>' }));
  assert.equal(city.facts.company, null, 'the job location is not the employer');
  const generic = extract(vacancy({ title: 'Vacature: Adviseur, Belastingdienst - Werken bij', body: '<h2>Over ons</h2><h2>Over de functiegroep Adviseur</h2><h2>Over deze vacature</h2><h2>Over jou</h2>' }));
  assert.equal(generic.facts.company, null);
});

test('running text: only a label opening a line counts, with a value that looks like an organisation', () => {
  const { facts, diagnostic } = extract(vacancy({ body: '\n<p>Algemeen</p>\nWerkgever: Ministerie van Defensie\n' }));
  assert.equal(facts.company, 'Ministerie van Defensie');
  assert.equal(diagnostic.companySource, 'text_fallback');
  assert.equal(extractCompanyFromText('- Organisatie - Dienst Justitiële Inrichtingen\nrest'), 'Dienst Justitiële Inrichtingen');
  assert.equal(extractCompanyFromText('Employer: Acme Analytics BV; Utrecht'), 'Acme Analytics BV');
});

// ─── no loose sentence fragments ────────────────────────────────────────────────────────────

test('sentence fragments after the word "organisatie" in running text are never the employer (the live "inrichting." case)', () => {
  const body = `<p>Je hebt direct invloed op de kwaliteit van de organisatie-inrichting. Dit zegt een collega over jouw werkomgeving.</p>
    <p>Daarnaast formuleert de directie het organisatie- en personeelsbeleid.</p>
    <p>Aansturen organisatie: je vertaalt de missie en visie van de organisatie in een strategie en operationele doelen.</p>`;
  assert.equal(extractCompanyFromText(body.replace(/<[^>]+>/g, '\n')), null);
  const { facts, diagnostic } = extract(vacancy({ body }));
  assert.equal(facts.company, null);
  assert.equal(diagnostic.companySource, 'none');
  // Even at the start of a line, a lowercase fragment or a sentence is not an organisation name.
  assert.equal(extractCompanyFromText('Organisatie: inrichting.\n'), null);
  assert.equal(extractCompanyFromText('Organisatie: je vertaalt de missie en visie van de organisatie in een strategie en operationele doelen.\n'), null);
  assert.equal(extractCompanyFromText('Werkgever: wij bieden je een salaris van € 4.000 per maand\n'), null);
});

test('call-to-action, navigation and vacancy content are never the employer, from any source', () => {
  for (const value of ['Solliciteer direct', 'Bekijk alle vacatures', 'Naar overzicht', 'Meer informatie over deze vacature', 'Contact', 'Terug', 'Lees meer']) {
    assert.equal(assessCompanyName(value, 'explicit'), null, value);
    assert.equal(assessCompanyName(value, 'text'), null, value);
  }
  for (const value of ['36 uur per week', '€ 3.500 per maand', 'Je zorgt voor de dagelijkse werkzaamheden', 'Minimaal 3 jaar ervaring']) {
    assert.equal(assessCompanyName(value, 'text'), null, value);
  }
  assert.equal(extract(vacancy({ body: '<dl><dt>Organisatie</dt><dd>Solliciteer direct</dd></dl>' })).facts.company, null);
  assert.equal(extract(vacancy({ body: '\nWerkgever: Bekijk alle vacatures\n' })).facts.company, null);
});

test('legitimate organisation names stay valid: several words, legal forms, acronyms, ampersands, punctuation', () => {
  for (const name of ['SPIE', 'Stichting BOOR', 'Ministerie van Defensie', 'Rijkswaterstaat', 'Hoogheemraadschap van Delfland', 'Dienst Justitiële Inrichtingen', 'TNO',
    'Bedrijf B.V.', 'Company & Partners', 'de Bijenkorf', 'Nederlandse Voedsel- en Warenautoriteit (NVWA)', 'Van der Valk Hotels N.V.', 'Acme Analytics BV', "'s Heeren Loo", 'Rijksvastgoedbedrijf (Ministerie van BZK)']) {
    assert.equal(assessCompanyName(name, 'explicit'), name, `explicit: ${name}`);
    assert.equal(assessCompanyName(name, 'text'), name, `text: ${name}`);
  }
  assert.equal(assessCompanyName('  Stichting   BOOR \n', 'text'), 'Stichting BOOR', 'only whitespace is normalised');
  assert.equal(extractCompanyFromText('Werkgever: Ministerie van Justitie en Veiligheid, Dienst Justitiële Inrichtingen\n'), 'Ministerie van Justitie en Veiligheid, Dienst Justitiële Inrichtingen');
});

test('the name is kept as written: no legal form removed, nothing rewritten', () => {
  const { facts } = extract(vacancy({ body: '<dl><dt>Werkgever:</dt><dd>: Acme &amp; Zonen B.V. (Utrecht)</dd></dl>' }));
  assert.equal(facts.company, 'Acme & Zonen B.V. (Utrecht)');
});

// ─── null beats a wrong name; weak never overrides strong ───────────────────────────────────

test('without a reliable employer the company is null and the source is "none"', () => {
  const { facts, diagnostic } = extract(vacancy({ title: 'Vacature: Adviseur', body: '<p>Een mooie functie in een dynamische omgeving.</p>' }));
  assert.equal(facts.company, null);
  assert.equal(diagnostic.companySource, 'none');
  assert.equal(diagnostic.accepted, true, 'the vacancy is still recognised without a company');
});

test('chooseCompany: a weak candidate never overrides a strong one, and an invalid strong-slot value falls through', () => {
  assert.deepEqual(chooseCompany({ jsonLd: 'A', microdata: 'B', explicitLabel: 'C', organizationBlock: 'D', text: 'E' }), { value: 'A', source: 'json_ld' });
  assert.deepEqual(chooseCompany({ microdata: 'B', explicitLabel: 'C', organizationBlock: 'D', text: 'E' }), { value: 'B', source: 'microdata' });
  assert.deepEqual(chooseCompany({ explicitLabel: 'Label BV', organizationBlock: 'Block BV', text: 'Text BV' }), { value: 'Label BV', source: 'explicit_label' });
  assert.deepEqual(chooseCompany({ organizationBlock: 'Block BV', text: 'Text BV' }), { value: 'Block BV', source: 'organization_block' });
  assert.deepEqual(chooseCompany({ text: 'Text BV' }), { value: 'Text BV', source: 'text_fallback' });
  assert.deepEqual(chooseCompany({ explicitLabel: 'Solliciteer direct', text: 'inrichting.' }), { value: null, source: 'none' });
  assert.deepEqual(chooseCompany({ explicitLabel: 'Solliciteer direct', organizationBlock: 'Block BV' }), { value: 'Block BV', source: 'organization_block' });
  assert.deepEqual(chooseCompany({}), { value: null, source: 'none' });
});

// ─── realistic shapes ───────────────────────────────────────────────────────────────────────

test('a WBO-shaped detail page: the fragment in the body text is ignored and the employer comes from its own "Over <Name>" section', () => {
  const html = `<html><head><title>Vacature: Adviseur formatiebeheer &amp; functiewaardering, Belastingdienst - Werken bij de Overheid</title></head><body>
    <main><h1>Werken bij de Overheid</h1>
      <h2>Dit ga je doen</h2><p>Je hebt direct invloed op de kwaliteit van de organisatie-inrichting. Dit zegt een collega over jouw werkomgeving.</p>
      <h2>Dit krijg je</h2><ul><li><span aria-label="Salaris"></span><span>€ 3.496 - € 5.535 (bruto)</span></li><li><span aria-label="Uren per week"></span><span>32 - 36 uur</span></li></ul>
      <h2>Over Belastingdienst</h2><p>Bij de Belastingdienst werken ongeveer 25.000 mensen.</p>
      <h2>Over de functiegroep Adviseur</h2><p>Aansturen organisatie: je vertaalt de missie en visie van de organisatie in een strategie.</p>
    </main></body></html>`;
  const { facts, diagnostic } = extract(html, 'https://werkenbijoverheid.example/vacatures/adviseur-BD-2026-4455');
  assert.equal(facts.company, 'Belastingdienst');
  assert.equal(diagnostic.companySource, 'organization_block');
});

test('a SPIE-shaped JobPosting keeps company "SPIE" and its other fields', () => {
  const { facts, diagnostic } = extract(`<html><head><title>Tender Manager</title>${jobPosting('SPIE')}</head><body><a href="mailto:jobs@careers.example">Solliciteer</a></body></html>`,
    'https://careers.example/vacatures/commercie-en-advies/tender-manager-hengelo-1');
  assert.equal(facts.company, 'SPIE');
  assert.equal(facts.location, 'Utrecht');
  assert.equal(diagnostic.companySource, 'json_ld');
  assert.equal(diagnostic.accepted, true);
});

test('a page rejected as not-a-vacancy still reports where its (absent) company came from', () => {
  const { facts, diagnostic } = extract('<html><head><title>Contact</title></head><body><main><h1>Contact</h1><p>Neem contact op.</p></main></body></html>', 'https://careers.example/contact');
  assert.equal(facts, undefined);
  assert.equal(diagnostic.companySource, 'none');
});

// ─── organisation blocks confirmed by the title: the two live false negatives ───────────────────

test('live regression A: "Over Ministerie van Onderwijs, Cultuur en Wetenschap." (sentence-final stop) is the employer, without the stop', () => {
  for (const title of ['Vacature: Beleidsmedewerker, Ministerie van Onderwijs, Cultuur en Wetenschap. - Werken bij', 'Vacature: Beleidsmedewerker, Ministerie van Onderwijs, Cultuur en Wetenschap - Werken bij']) {
    const { facts, diagnostic } = extract(vacancy({ title, body: '<h2>Meer over Verduurzaming scholenbouw</h2><h2>Over Ministerie van Onderwijs, Cultuur en Wetenschap.</h2><p>Bij het ministerie werk je aan onderwijs.</p>' }));
    assert.equal(facts.company, 'Ministerie van Onderwijs, Cultuur en Wetenschap', title);
    assert.equal(diagnostic.companySource, 'organization_block', title);
  }
});

test('live regression B: an 11-word, 88-character name with parentheses is kept in full', () => {
  const name = 'Organisatie en Personeel Rijk (Ministerie van Binnenlandse Zaken en Koninkrijksrelaties)';
  const { facts, diagnostic } = extract(vacancy({
    title: `Vacature: Medior Functioneel Beheerder, ${name} - Werken bij`,
    body: `<h2>Meer over jouw toekomstige plek in de organisatie</h2><h2>Over ${name}</h2><h2>Over de functiegroep Adviseur Bedrijfsvoering</h2>`,
  }));
  assert.equal(facts.company, name);
  assert.equal(diagnostic.companySource, 'organization_block');
});

test('a sentence-final stop is removed only from a structured name; abbreviations and legal forms keep theirs', () => {
  assert.equal(extract(vacancy({ title: 'Vacature: Adviseur, Voorbeeld B.V. - Werken bij', body: '<h2>Over Voorbeeld B.V.</h2>' })).facts.company, 'Voorbeeld B.V.');
  assert.equal(extract(vacancy({ title: 'Vacature: Adviseur, Acme Inc. - Werken bij', body: '<h2>About Acme Inc.</h2>' })).facts.company, 'Acme Inc.');
  assert.equal(extract(vacancy({ title: 'Vacature: Adviseur, Acme Ltd. en Zonen - Werken bij', body: '<h2>Over Acme Ltd. en Zonen.</h2>' })).facts.company, 'Acme Ltd. en Zonen');
  assert.equal(stripSentencePeriod('Ministerie van Onderwijs, Cultuur en Wetenschap.'), 'Ministerie van Onderwijs, Cultuur en Wetenschap');
  for (const kept of ['Voorbeeld B.V.', 'Acme N.V.', 'Acme Inc.', 'Acme Ltd.', 'Bedrijf e.d.', 'Stichting BOOR']) assert.equal(stripSentencePeriod(kept), kept, kept);
  assert.equal(stripSentencePeriod('Naam..'), 'Naam.', 'only one stop is removed');
});

test('the heading is compared with the title after whitespace/Unicode normalisation, without fuzzy matching', () => {
  const ok = extract(vacancy({ title: 'Vacature: Adviseur,   Dienst   Justitiële Inrichtingen . - Werken bij', body: '<h2>Over  Dienst Justitiële   Inrichtingen.</h2>' }));
  assert.equal(ok.facts.company, 'Dienst Justitiële Inrichtingen');
  // Decomposed (NFD) in the title, composed (NFC) in the heading: still the same name.
  const decomposed = extract(vacancy({ title: 'Vacature: Adviseur, Dienst Justitiële Inrichtingen - Werken bij', body: '<h2>Over Dienst Justitiële Inrichtingen</h2>' }));
  assert.equal(decomposed.facts.company, 'Dienst Justitiële Inrichtingen');
  // A different spelling is not "close enough".
  const different = extract(vacancy({ title: 'Vacature: Adviseur, Dienst Justitiele Inrichtingen - Werken bij', body: '<h2>Over Dienst Justitiële Inrichtingen</h2>' }));
  assert.equal(different.facts.company, null);
});

test('title confirmation stays essential: generic "Over ..." headings are never the employer, even if their words appear in the title', () => {
  const title = 'Vacature: Adviseur Utrecht, Expert functie arbeidsvoorwaarden solliciteren functiegroep - Werken bij';
  const headings = ['Over Utrecht', 'Over ons', 'Over deze vacature', 'Over de functie', 'Over de functiegroep Expert', 'Over arbeidsvoorwaarden', 'Over solliciteren', 'Over jou', 'Over het team'];
  const { facts, diagnostic } = extract(vacancy({ title, body: headings.map(heading => `<h2>${heading}</h2>`).join('') }));
  assert.equal(facts.company, null);
  assert.equal(diagnostic.companySource, 'none');
  // A well-formed name that the title does not mention is not confirmed.
  assert.equal(extract(vacancy({ title: 'Vacature: Adviseur - Werken bij', body: '<h2>Over Organisatie en Personeel Rijk (Ministerie van Binnenlandse Zaken en Koninkrijksrelaties)</h2>' })).facts.company, null);
});

test('a structured block is never a paragraph, a call to action or prose, whatever the title says', () => {
  const paragraph = 'Bij ons werk je aan mooie projecten. Je krijgt veel ruimte voor persoonlijke ontwikkeling en een goed salaris per maand.';
  assert.equal(assessCompanyName(paragraph, 'structured'), null);
  assert.equal(assessCompanyName('X'.repeat(151), 'structured'), null);
  assert.equal(assessCompanyName('Solliciteer direct bij ons', 'structured'), null);
  assert.equal(assessCompanyName('Wij zijn een organisatie die werkt aan de toekomst', 'structured'), null);
  const { facts } = extract(vacancy({ title: `Vacature: Adviseur, ${paragraph} - Werken bij`, body: `<h2>Over ${paragraph}</h2><div class="employer-name">${paragraph}</div>` }));
  assert.equal(facts.company, null);
});

test('long valid organisation names are accepted where they are structured, without an arbitrary word limit', () => {
  for (const name of ['Nederlandse Voedsel- en Warenautoriteit (NVWA)', 'Organisatie en Personeel Rijk (Ministerie van Binnenlandse Zaken en Koninkrijksrelaties)',
    'Ministerie van Onderwijs, Cultuur en Wetenschap', 'Ministerie van Justitie en Veiligheid, Dienst Justitiële Inrichtingen', 'Hoogheemraadschap van Delfland', 'Koninklijke Nederlandse Akademie van Wetenschappen (KNAW)']) {
    assert.equal(assessCompanyName(name, 'structured'), name, name);
    const { facts, diagnostic } = extract(vacancy({ title: `Vacature: Adviseur, ${name} - Werken bij`, body: `<h2>Over ${name}</h2>` }));
    assert.equal(facts.company, name, name);
    assert.equal(diagnostic.companySource, 'organization_block', name);
  }
});

test('free text stays strict: the same long or full-stopped names are NOT taken from running text, and the old fragments still fail', () => {
  assert.equal(assessCompanyName('Ministerie van Onderwijs, Cultuur en Wetenschap.', 'text'), null, 'a stop after a plain word in running text');
  assert.equal(assessCompanyName('Organisatie en Personeel Rijk (Ministerie van Binnenlandse Zaken en Koninkrijksrelaties)', 'text'), null, 'over the free-text word limit');
  assert.equal(extractCompanyFromText('Werkgever: Ministerie van Onderwijs, Cultuur en Wetenschap.\n'), null);
  assert.equal(extractCompanyFromText('Werkgever: Organisatie en Personeel Rijk (Ministerie van Binnenlandse Zaken en Koninkrijksrelaties)\n'), null);
  for (const fragment of ['organisatie-inrichting.', 'inrichting.', 'je vertaalt de missie en visie van de organisatie in een strategie en operationele doelen.', 'Aansturen organisatie: je vertaalt de missie']) {
    assert.equal(assessCompanyName(fragment, 'text'), null, fragment);
    assert.equal(assessCompanyName(fragment, 'structured'), null, `structured: ${fragment}`);
  }
  const body = '<p>Je hebt invloed op de kwaliteit van de organisatie-inrichting. Dit zegt een collega.</p><p>Aansturen organisatie: je vertaalt de missie en visie van de organisatie in een strategie.</p>';
  assert.equal(extract(vacancy({ title: 'Vacature: Adviseur, Belastingdienst - Werken bij', body })).facts.company, null);
});
