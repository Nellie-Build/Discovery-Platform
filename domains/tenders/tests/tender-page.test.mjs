import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { assessTenderPage, mapTenderPage, tenderPageIdentity } from '../dist/index.js';
import { DETAIL_BOUW, DETAIL_RFP, DETAIL_OFFERTE, OVERVIEW, GENERAL, GENERAL_WITH_DOCS, EVENT_NOT_TENDER, NEWS, page } from './fake-web.mjs';

const assess = (html, path = '/aanbestedingen/voorbeeld-opdracht') => assessTenderPage({ $: load(html), url: `https://gemeente-voorbeeld.example${path}` });

test('a concrete tender page: title, deadline (with time), reference, CPV, authority, procedure, publication date and location are extracted', () => {
  const a = assess(DETAIL_BOUW);
  assert.equal(a.kind, 'detail');
  assert.equal(a.rejection, null);
  assert.deepEqual(
    { title: a.facts.title, authority: a.facts.contractingAuthority, reference: a.facts.referenceNumber, deadline: a.facts.submissionDeadline, procedure: a.facts.procedureType, published: a.facts.publicationDate, location: a.facts.location },
    { title: 'Aanbesteding renovatie basisschool De Ster', authority: 'Gemeente Voorbeeld', reference: 'GV-2026-041', deadline: '2026-11-12T12:00:00', procedure: 'Openbare procedure', published: '2026-10-01', location: 'Delft' },
  );
  assert.deepEqual(a.facts.cpvCodes, [{ code: '45214200', description: null, main: true }], 'the check digit of "45214200-2" is dropped');
  assert.equal(a.facts.documentCount, 1);
  for (const signal of ['deadline', 'reference', 'cpv', 'procedure', 'documents']) assert.ok(a.signals.includes(signal), signal);
});

test('an English RFP with a table layout is recognised too (label variants, English dates, "at 14:00")', () => {
  const a = assess(DETAIL_RFP);
  assert.equal(a.kind, 'detail');
  assert.equal(a.facts.referenceNumber, 'RFP-2026-07');
  assert.equal(a.facts.submissionDeadline, '2026-11-03T14:00:00');
  assert.equal(a.facts.contractingAuthority, 'Gemeente Voorbeeld');
  assert.deepEqual(a.facts.cpvCodes.map(c => c.code), ['79710000']);
});

test('a plain request for quotation with a numeric day-first date and "vóór 10.00 uur" still counts: deadline and a document link are enough with tender wording', () => {
  const a = assess(DETAIL_OFFERTE);
  assert.equal(a.kind, 'detail');
  assert.equal(a.facts.submissionDeadline, '2026-11-20T10:00:00');
  assert.equal(a.facts.referenceNumber, null, 'missing optional fields stay null, never guessed');
  assert.equal(a.facts.contractingAuthority, null);
  assert.deepEqual(a.facts.cpvCodes, []);
});

test('a page listing several tenders is an overview, even though every item shows a deadline date', () => {
  const a = assess(OVERVIEW, '/aanbestedingen');
  assert.equal(a.kind, 'overview');
  assert.equal(a.rejection, 'overview_page');
  assert.equal(a.facts, null);
  assert.ok(a.tenderLinks >= 4);
});

test('general purchasing information is never a tender, even when it mentions "aanbesteding" and links documents', () => {
  for (const [html, path] of [[GENERAL, '/inkoop/leveranciers'], [GENERAL_WITH_DOCS, '/inkoop/inkoopbeleid']]) {
    const a = assess(html, path);
    assert.equal(a.kind, 'general', path);
    assert.equal(a.rejection, 'general_procurement_information');
    assert.equal(a.facts, null);
  }
});

test('no false positive: a workshop with a sign-up deadline and a downloadable programme lacks tender intent', () => {
  const a = assess(EVENT_NOT_TENDER, '/nieuws/workshop');
  assert.equal(a.kind, 'none');
  assert.equal(a.rejection, 'insufficient_evidence');
  assert.equal(assess(NEWS, '/nieuws').rejection, 'no_tender_evidence');
});

test('a supplier page with a deadline-like date but no reference, procedure or tender wording is not a tender', () => {
  const a = assess(page('Leveranciers', '<h1>Leveranciers</h1><p>Facturen moeten uiterlijk 30 dagen na ontvangst zijn betaald. Sluitingsdatum kantoor: 24 december 2026.</p>'), '/leveranciers');
  assert.notEqual(a.kind, 'detail');
});

test('one strong signal is not enough: a title with tender wording and only a deadline stays rejected', () => {
  const a = assess(page('Aanbesteding', '<h1>Aanbesteding</h1><p>Sluitingsdatum: 5 december 2026.</p>'), '/informatie/aanbesteding');
  assert.equal(a.kind, 'none');
  assert.equal(a.rejection, 'insufficient_evidence');
});

test('dates are read day-first, in Dutch and English, and impossible dates are ignored', () => {
  const deadline = text => assess(page('Aanbesteding x', `<h1>Aanbesteding voorbeeld opdracht</h1><p>Kenmerk: AB-12345. Sluitingsdatum: ${text}</p>`)).facts?.submissionDeadline ?? null;
  assert.equal(deadline('3 maart 2027'), '2027-03-03');
  assert.equal(deadline('03-03-2027 om 09:30'), '2027-03-03T09:30:00');
  assert.equal(deadline('March 3, 2027'), '2027-03-03');
  assert.equal(deadline('2027-03-03'), '2027-03-03');
  assert.equal(deadline('31-02-2027'), null, 'a date that does not exist');
});

test('a reference must contain a digit: the word after "referentie" alone is not a reference', () => {
  const a = assess(page('Aanbesteding', '<h1>Aanbesteding schoonmaak kantoor</h1><p>Referentie: schoonmaak. Sluitingsdatum: 5 december 2026. <a href="/x.pdf">Documenten</a></p>'));
  assert.equal(a.facts.referenceNumber, null);
});

test('the tender identity of a page is its host + path (no www, no trailing slash, no tracking or fragment); nothing else takes part', () => {
  const identity = tenderPageIdentity('https://www.gemeente-voorbeeld.example/aanbestedingen/x/?utm_source=a#top');
  assert.equal(identity, 'gemeente-voorbeeld.example/aanbestedingen/x');
  assert.equal(tenderPageIdentity('https://gemeente-voorbeeld.example/aanbestedingen/x'), identity);
  assert.notEqual(tenderPageIdentity('https://gemeente-voorbeeld.example/tender?id=1'), tenderPageIdentity('https://gemeente-voorbeeld.example/tender?id=2'));
});

test('mapTenderPage gives TenderFacts with provenance; only a concrete tender is mapped; re-mapping the same page is stable', () => {
  const discovery = { via: 'website_crawl', host: 'gemeente-voorbeeld.example', query: null, searchProvider: null, discoveredFrom: 'https://gemeente-voorbeeld.example/aanbestedingen', evidence: ['deadline'] };
  const raw = { url: 'https://gemeente-voorbeeld.example/aanbestedingen/renovatie', assessment: assess(DETAIL_BOUW, '/aanbestedingen/renovatie'), discovery };
  const facts = mapTenderPage(raw);
  assert.equal(facts.sourceSystem, 'website');
  assert.equal(facts.tenderIdentity, 'gemeente-voorbeeld.example/aanbestedingen/renovatie');
  assert.equal(facts.sourceUrl, raw.url);
  assert.equal(facts.submissionDeadline, '2026-11-12T12:00:00');
  assert.deepEqual(facts.discovery, discovery);
  assert.deepEqual(facts.publications.map(p => [p.publicationId, p.noticeType]), [['gemeente-voorbeeld.example/aanbestedingen/renovatie', 'webpage']]);
  assert.deepEqual(mapTenderPage(raw), facts);
  assert.equal(mapTenderPage({ ...raw, assessment: assess(OVERVIEW, '/aanbestedingen') }), null);
});

test('a news item that only says "Europese aanbesteding" in running text and names a reference is not enough evidence (procedure counts only under a label)', () => {
  const a = assess(page('Hoveniers uitgenodigd voor aanbesteding groenonderhoud', '<h1>Hoveniers uitgenodigd voor aanbesteding groenonderhoud</h1><p>Het waterschap organiseert een Europese aanbesteding voor groenonderhoud (kenmerk T100537). Regionale hoveniers zijn uitgenodigd.</p>'), '/nieuws/hoveniers-uitgenodigd-voor-aanbesteding-groenonderhoud');
  assert.equal(a.kind, 'none');
  assert.equal(a.rejection, 'insufficient_evidence');
  assert.equal(a.facts, null);
});

test('one tender written as prose with a list of related tenders and many document links is still one tender, not an overview', () => {
  const related = Array.from({ length: 6 }, (_, i) => `<li><a href="/aanbestedingen/ander-project-${i}-nieuwbouw">Aanbesteding ander project ${i} nieuwbouw</a> deadline ${10 + i} mei 2027</li>`).join('');
  const docs = Array.from({ length: 8 }, (_, i) => `<li><a href="/aanbestedingen/23074-renovatie-kantoor/doc-${i}">23074 Aanbestedingsleidraad deel ${i}</a></li>`).join('');
  const html = page('Renovatie kantoor', `<h1>Aanbesteding renovatie en vernieuwbouw kantoor</h1><p>Deze aanbesteding is gepubliceerd op 19 juli 2025 en de deadline is 20 april 2026. CPV: 45000000. Bekijk hieronder de documenten.</p><ul>${docs}</ul><h2>Gerelateerde aanbestedingen</h2><ul>${related}</ul>`);
  const a = assess(html, '/aanbestedingen/23074-renovatie-en-vernieuwbouw-kantoor-zwolle');
  assert.equal(a.kind, 'detail');
  assert.equal(a.facts.submissionDeadline, '2026-04-20');
  // The same content on a listing-style URL stays an overview.
  assert.equal(assess(html, '/aanbestedingen').kind, 'overview');
});

test('the contracting authority is never guessed from the site name', () => {
  const a = assess(page('Offerteaanvraag x', '<h1>Offerteaanvraag schilderwerk</h1><p>Uiterlijk indienen: 20-11-2026.</p><a href="/a.pdf">Bestek</a>', '<meta property="og:site_name" content="Een Aggregator">'));
  assert.equal(a.kind, 'detail');
  assert.equal(a.facts.contractingAuthority, null);
});

test('"Aanbesteden bij gemeente X" and "Ons inkoopbeleid" are general pages, even with a date and a downloadable document', () => {
  const html = title => page(title, `<h1>${title}</h1><p>Wij nodigen leveranciers uit. Lees ons beleid, gepubliceerd op 3 maart 2026.</p><a href="/files/beleid.pdf">Beleid (pdf)</a>`);
  for (const [title, path] of [['Aanbesteden bij gemeente Voorbeeld', '/zakelijk/aanbesteden-bij-gemeente-voorbeeld'], ['Ons inkoopbeleid', '/zakelijk/ons-inkoopbeleid'], ['Zo koopt onze organisatie in', '/zakelijk/inkoop']]) {
    const a = assess(html(title), path);
    assert.equal(a.kind, 'general', title);
    assert.equal(a.facts, null);
  }
});

test('a news item that only reports that a tender takes place is no tender record, even when it names a deadline', () => {
  const a = assess(page('Nieuws: gemeente start aanbesteding voor nieuwe brug', '<h1>Gemeente start aanbesteding voor nieuwe brug</h1><p>De gemeente publiceert deze week de aanbesteding voor de nieuwe brug. Inschrijven kan tot 12 november 2026.</p>'), '/nieuws/gemeente-start-aanbesteding-nieuwe-brug');
  assert.equal(a.kind, 'none');
  assert.equal(a.facts, null);
});

test('a page that lists several procurements inline (several different reference numbers, no links) is an overview, not one tender with the first item\'s data', () => {
  const item = (title, ref, date) => `<h2>${title}</h2><p>Reference: ${ref}</p><p>Deadline: ${date}</p><a href="/docs/${ref}.pdf">Contract notice</a>`;
  const html = page('Open tenders', `<h1>Open tenders</h1>${item('Technical assistance framework', 'NDCE-XX-1', '13 August 2026')}${item('Programme delivery consultant', 'DFCD-XX-1', '17 May 2026')}${item('ESG capacity building', 'EFSD-TA-001', '24 April 2026')}`);
  const a = assess(html, '/open-tenders');
  assert.equal(a.kind, 'overview');
  assert.equal(a.rejection, 'overview_page');
  assert.equal(a.facts, null);
  // One tender with its own slug that mentions a second reference (a predecessor) stays a detail.
  const one = assess(page('Aanbesteding', '<h1>Aanbesteding renovatie kantoor</h1><dl><dt>Kenmerk</dt><dd>AB-100</dd><dt>Sluitingsdatum</dt><dd>1 december 2026</dd></dl><p>Vervangt eerdere aanbesteding, kenmerk AB-099.</p>'), '/aanbestedingen/renovatie-kantoor-hoofdgebouw');
  assert.equal(one.kind, 'detail');
});
