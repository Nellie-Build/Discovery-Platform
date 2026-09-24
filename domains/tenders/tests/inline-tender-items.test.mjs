import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from 'cheerio';
import { assessTenderPage, assessTenderPageMulti, splitTenderPageSections, mapTenderPage, tenderPageIdentity, tenderPageItemIdentity } from '../dist/index.js';
import {
  MULTI_TENDER_CARDS, MULTI_TENDER_HEADINGS, SINGLE_QUALIFYING_HEADING, DETAIL_BOUW, DETAIL_RFP, DETAIL_OFFERTE, OVERVIEW, GENERAL, GENERAL_WITH_DOCS, EVENT_NOT_TENDER, NEWS,
} from './fake-web.mjs';

/**
 * A page can itself list several concrete procurements (no separate links to another page for each — the generic
 * pattern behind an organisation's own "open tenders" page). assessTenderPageMulti still yields one detail-kind
 * TenderPageAssessment per procurement, each scoped strictly to its own section so nothing leaks between them.
 */
const multi = (html, url = 'https://organisatie.example/open-opdrachten') => assessTenderPageMulti({ $: load(html), url });
const byTitle = (items, title) => items.find(item => item.facts.title === title);

test('assessTenderPage alone still calls a page with several inline procurements an overview (unchanged, existing behaviour)', () => {
  const single = assessTenderPage({ $: load(MULTI_TENDER_CARDS), url: 'https://organisatie.example/open-opdrachten' });
  assert.equal(single.kind, 'overview');
  assert.equal(single.rejection, 'overview_page');
  assert.equal(single.facts, null);
});

test('card sections: each procurement (its own <article>, heading, reference, deadline, documents) becomes its own detail record', () => {
  const items = multi(MULTI_TENDER_CARDS);
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 4, 'all four procurements qualify (each has its own reference or deadline)');
  assert.ok(items.every(item => item.kind === 'detail' && item.rejection === null));

  const a = byTitle(items, 'Raamovereenkomst technische bijstand');
  assert.equal(a.facts.referenceNumber, 'ABC-XX-1');
  assert.equal(a.facts.submissionDeadline, '2026-08-13T17:00:00');
  assert.equal(a.facts.documentCount, 1);
  assert.equal(a.sectionAnchor, 'opdracht-raamovereenkomst-technische-bijstand');
  assert.equal(a.url, 'https://organisatie.example/open-opdrachten#opdracht-raamovereenkomst-technische-bijstand', 'a real anchor id becomes part of the URL');

  const b = byTitle(items, 'Coördinator programma-uitvoering');
  assert.equal(b.facts.referenceNumber, 'DEF-XX-2');
  assert.equal(b.facts.documentCount, 2, 'this item alone has two of its own document links');
});

test('missing data: an item with only a deadline (no reference) still qualifies; fields never leak from one item to another', () => {
  const items = multi(MULTI_TENDER_CARDS);
  const onboarding = byTitle(items, 'Onboarding nieuwe leveranciers');
  assert.equal(onboarding.facts.referenceNumber, null, 'no reference on this item: stays null, never invented');
  assert.equal(onboarding.facts.submissionDeadline, '2026-02-06T17:00:00');
  assert.equal(onboarding.facts.documentCount, 1);
  // No cross-contamination: every item's reference and deadline are its own.
  const refs = items.map(item => item.facts.referenceNumber).filter(Boolean);
  assert.equal(new Set(refs).size, refs.length, 'no two items share a reference');
  const deadlines = items.map(item => item.facts.submissionDeadline);
  assert.equal(new Set(deadlines).size, deadlines.length, 'no two items share a deadline');
});

test('flat markup (no card containers): a run of h2 headings still splits, one item per heading with its own reference-or-deadline; a heading with neither is left out', () => {
  const items = multi(MULTI_TENDER_HEADINGS, 'https://organisatie.example/lopende-opdrachten');
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 2, 'the newsletter heading (neither reference nor deadline) does not become a third item');
  const onderhoud = byTitle(items, 'Onderhoud technische installaties');
  assert.equal(onderhoud.facts.referenceNumber, 'ONH-2026-09');
  assert.equal(onderhoud.facts.submissionDeadline, null, 'this item states no deadline of its own');
  assert.equal(onderhoud.facts.documentCount, 1);
  const meubilair = byTitle(items, 'Levering kantoormeubilair');
  assert.equal(meubilair.facts.referenceNumber, 'LKM-2026-14');
  assert.equal(meubilair.facts.submissionDeadline, null, 'this item states no deadline of its own');
  // No real DOM anchor in this fixture: the URL stays the plain page URL, never a fabricated fragment.
  assert.ok(items.every(item => item.sectionAnchor === null && item.url === 'https://organisatie.example/lopende-opdrachten'));
  // The identity fragment still exists and is derived from the heading text, not invented.
  assert.ok(items.every(item => typeof item.sectionId === 'string' && item.sectionId.length > 0));
  assert.notEqual(onderhoud.sectionId, meubilair.sectionId);
});

test('only one section actually qualifies: splitTenderPageSections refuses (needs at least two), never a partial split into one item', () => {
  const url = 'https://organisatie.example/inkoopinformatie';
  const role = { role: 'unknown_web_source', confidence: 'low', evidence: [] };
  const items = splitTenderPageSections(load(SINGLE_QUALIFYING_HEADING), url, null, role);
  assert.deepEqual(items, []);
});

test('ordinary pages are entirely unaffected: a single concrete tender, a link-based overview, general information, a news item and a page with no tender evidence all give exactly what assessTenderPage alone gives', () => {
  for (const [html, url] of [
    [DETAIL_BOUW, 'https://gemeente-voorbeeld.example/aanbestedingen/x'], [DETAIL_RFP, 'https://gemeente-voorbeeld.example/aanbestedingen/y'], [DETAIL_OFFERTE, 'https://gemeente-voorbeeld.example/aanbestedingen/z'],
    [OVERVIEW, 'https://gemeente-voorbeeld.example/aanbestedingen'], [GENERAL, 'https://gemeente-voorbeeld.example/inkoop/leveranciers'], [GENERAL_WITH_DOCS, 'https://gemeente-voorbeeld.example/inkoop/inkoopbeleid'],
    [EVENT_NOT_TENDER, 'https://gemeente-voorbeeld.example/nieuws/workshop'], [NEWS, 'https://gemeente-voorbeeld.example/nieuws'],
  ]) {
    const page = { $: load(html), url };
    const single = assessTenderPage(page);
    const multiResult = assessTenderPageMulti(page);
    assert.equal(Array.isArray(multiResult), false, url);
    assert.deepEqual(multiResult, single, url);
  }
});

test('mapTenderPage: each split item gets its own identity (page identity + its own section characteristic), never a fabricated tender number', () => {
  const items = multi(MULTI_TENDER_CARDS);
  const facts = items.map(item => mapTenderPage({ url: item.url, assessment: item, discovery: { via: 'website_crawl', host: 'organisatie.example', query: null, searchProvider: null, discoveredFrom: null, evidence: item.signals } }));
  assert.ok(facts.every(f => f.sourceSystem === 'website'));
  const identities = facts.map(f => f.tenderIdentity);
  assert.equal(new Set(identities).size, identities.length, 'every item has its own identity');
  for (const f of facts) assert.equal(f.tenderIdentity, f.publicationId);
  const a = byTitle(items, 'Raamovereenkomst technische bijstand');
  assert.equal(tenderPageItemIdentity(a.url, a.sectionId), facts.find(f => f.title === a.facts.title).tenderIdentity);
  assert.ok(identities.every(id => id.startsWith(tenderPageIdentity('https://organisatie.example/open-opdrachten'))), 'the page identity is a prefix of every item identity');
});

test('mapTenderPage of a non-split (single) detail assessment is unaffected: the plain page identity, exactly as before', () => {
  const page = { $: load(DETAIL_BOUW), url: 'https://gemeente-voorbeeld.example/aanbestedingen/x' };
  const single = assessTenderPage(page);
  const facts = mapTenderPage({ url: single.url, assessment: single, discovery: { via: 'website_crawl', host: 'gemeente-voorbeeld.example', query: null, searchProvider: null, discoveredFrom: null, evidence: single.signals } });
  assert.equal(facts.tenderIdentity, tenderPageIdentity(page.url));
});

test('recrawling the same page (a fresh parse of the identical HTML) yields exactly the same items and identities, in the same order', () => {
  const url = 'https://organisatie.example/open-opdrachten';
  const first = multi(MULTI_TENDER_CARDS, url);
  const again = multi(MULTI_TENDER_CARDS, url);
  assert.deepEqual(again.map(item => item.sectionId), first.map(item => item.sectionId));
  assert.deepEqual(again.map(item => item.url), first.map(item => item.url));
  assert.deepEqual(again, first);
});

test('duplicate identity fragments (two sections whose heading slugs collide) are disambiguated by position, not by inventing a data value', () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Open opdrachten</title></head><body><main><h1>Open opdrachten</h1>
    <h2>Onderhoud gebouwen</h2><p>Referentie: A-1</p><p>Sluitingsdatum: 1 december 2026.</p>
    <h2>Onderhoud gebouwen</h2><p>Referentie: A-2</p><p>Sluitingsdatum: 15 december 2026.</p>
  </main></body></html>`;
  const items = multi(html, 'https://organisatie.example/open-opdrachten');
  assert.equal(items.length, 2);
  assert.notEqual(items[0].sectionId, items[1].sectionId);
  assert.deepEqual(items.map(item => item.facts.referenceNumber), ['A-1', 'A-2']);
});
