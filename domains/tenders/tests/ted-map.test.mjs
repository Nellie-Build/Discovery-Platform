import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTedNotice, mergeTenderPublications, pickLanguage, tenderIdentityKey, mapTenderNedPublication } from '../dist/index.js';
import { notice } from './fake-ted.mjs';

const item = raw => ({ externalId: raw['publication-number'], sourceUrl: `https://ted.europa.eu/nl/notice/-/detail/${raw['publication-number']}`, fetchedAt: '2026-09-21T12:00:00.000Z', raw });

// The shape of a real TED notice (646401-2026, an Amsterdam UMC supplies tender), shortened.
const REAL = {
  'publication-number': '646401-2026', 'notice-identifier': 'f58b521d-0000-4000-8000-000000000001', 'notice-version': 1, 'procedure-identifier': 'dda2fca1-c11a-4d0c-8ab2-a5a7bed101dd',
  'notice-type': 'cn-standard', 'publication-date': '2026-09-21+02:00', 'title-proc': { nld: 'Levering van medische hulpmiddelen' }, 'description-proc': { nld: 'Levering en onderhoud.' },
  'buyer-name': { nld: ['Stichting Amsterdam UMC'] }, 'procedure-type': 'open', 'contract-nature': ['supplies', 'supplies'], 'classification-cpv': ['33183100', '33184100', '33183100', '33184100'],
  'place-of-performance': ['NLD', 'NLD'], 'deadline-receipt-tender-date-lot': ['2026-10-23+02:00'], 'deadline-receipt-tender-time-lot': ['12:00:00+02:00'],
  'estimated-value-proc': '11205000', 'estimated-value-cur-proc': 'EUR', 'estimated-value-lot': ['11205000'], 'estimated-value-cur-lot': ['EUR'], 'identifier-lot': ['LOT-0000'],
};

test('mapping a TED notice: every field of the minimal record, without TenderNed logic', () => {
  const facts = mapTedNotice(item(REAL));
  assert.deepEqual(facts, {
    sourceSystem: 'ted', tenderIdentity: 'dda2fca1-c11a-4d0c-8ab2-a5a7bed101dd', publicationId: '646401-2026',
    title: 'Levering van medische hulpmiddelen', contractingAuthority: 'Stichting Amsterdam UMC', referenceNumber: null,
    noticeType: 'cn-standard', noticeTypeLabel: 'Aankondiging van een opdracht', procedureType: 'Openbaar', contractType: 'Leveringen',
    cpvCodes: [{ code: '33183100', description: null, main: true }, { code: '33184100', description: null, main: false }],
    nutsCodes: [], location: null, publicationDate: '2026-09-21', submissionDeadline: '2026-10-23T12:00:00',
    estimatedValue: { amount: 11205000, currency: 'EUR' }, description: 'Levering en onderhoud.',
    sourceUrl: 'https://ted.europa.eu/nl/notice/-/detail/646401-2026',
    publications: [{ publicationId: '646401-2026', noticeType: 'cn-standard', noticeTypeLabel: 'Aankondiging van een opdracht', publicationDate: '2026-09-21', submissionDeadline: '2026-10-23T12:00:00', sourceUrl: 'https://ted.europa.eu/nl/notice/-/detail/646401-2026' }],
  });
});

test('places of performance: NUTS codes are kept, country codes are not, duplicates from several lots collapse', () => {
  const facts = mapTedNotice(item(notice({ 'place-of-performance': ['NL411', 'NL415', 'NLD', 'NLD', 'NL411', 'NL415', 'NL3', 'BEL'] })));
  assert.deepEqual(facts.nutsCodes.map(n => n.code), ['NL411', 'NL415', 'NL3']);
});

test('several lots: CPV and NUTS merge without duplicates, the deadline is the earliest, the value is the procedure value', () => {
  const facts = mapTedNotice(item(notice({
    'identifier-lot': ['LOT-0001', 'LOT-0002', 'LOT-0003'], 'classification-cpv': ['90510000', '90500000', '90510000', '90510000'],
    'deadline-receipt-tender-date-lot': ['2026-11-12+01:00', '2026-10-16+02:00', '2026-11-30+01:00'], 'deadline-receipt-tender-time-lot': ['10:00:00+01:00', '09:30:00+02:00', '10:00:00+01:00'],
    'estimated-value-proc': '900000', 'estimated-value-cur-proc': 'EUR', 'estimated-value-lot': ['300000', '300000', '300000'], 'estimated-value-cur-lot': ['EUR', 'EUR', 'EUR'],
    'place-of-performance': ['NL421', 'NLD', 'NL422', 'NLD', 'NL421'],
  })));
  assert.deepEqual(facts.cpvCodes.map(c => c.code), ['90510000', '90500000']);
  assert.equal(facts.cpvCodes[0].main, true);
  assert.equal(facts.cpvCodes[1].main, false);
  assert.deepEqual(facts.nutsCodes.map(n => n.code), ['NL421', 'NL422']);
  assert.equal(facts.submissionDeadline, '2026-10-16T09:30:00');
  assert.deepEqual(facts.estimatedValue, { amount: 900000, currency: 'EUR' });
});

test('several lots without a procedure value: the lot values add up only when every lot states one, in one currency', () => {
  const base = { 'estimated-value-proc': undefined, 'estimated-value-cur-proc': undefined, 'identifier-lot': ['LOT-0001', 'LOT-0002'] };
  assert.deepEqual(mapTedNotice(item(notice({ ...base, 'estimated-value-lot': ['100000', '250000.5'], 'estimated-value-cur-lot': ['EUR', 'EUR'] }))).estimatedValue, { amount: 350000.5, currency: 'EUR' });
  assert.equal(mapTedNotice(item(notice({ ...base, 'estimated-value-lot': ['100000'], 'estimated-value-cur-lot': ['EUR'] }))).estimatedValue?.amount, 100000, 'a single lot is its own value');
  assert.equal(mapTedNotice(item(notice({ ...base, 'estimated-value-lot': ['100000', null], 'estimated-value-cur-lot': ['EUR', 'EUR'] }))).estimatedValue, null, 'a lot without a value: no guess');
  assert.equal(mapTedNotice(item(notice({ ...base, 'estimated-value-lot': ['100000', '5000'], 'estimated-value-cur-lot': ['EUR', 'SEK'] }))).estimatedValue, null, 'mixed currencies are never added');
});

test('missing deadline and amount: null, never invented; a date without a time is kept as a date', () => {
  const none = mapTedNotice(item(notice({ 'deadline-receipt-tender-date-lot': undefined, 'deadline-receipt-tender-time-lot': undefined, 'estimated-value-proc': undefined, 'estimated-value-cur-proc': undefined, 'estimated-value-lot': undefined, 'estimated-value-cur-lot': undefined })));
  assert.equal(none.submissionDeadline, null);
  assert.equal(none.estimatedValue, null);
  assert.equal(none.publications[0].submissionDeadline, null);
  assert.equal(mapTedNotice(item(notice({ 'deadline-receipt-tender-time-lot': undefined }))).submissionDeadline, '2026-10-29');
  // Times in UTC ("Z") or with another offset are converted to Dutch local time, the form TenderNed publishes.
  assert.equal(mapTedNotice(item(notice({ 'deadline-receipt-tender-date-lot': ['2026-11-09Z'], 'deadline-receipt-tender-time-lot': ['22:59:00Z'] }))).submissionDeadline, '2026-11-09T23:59:00');
  assert.equal(mapTedNotice(item(notice({ 'deadline-receipt-tender-date-lot': ['2026-10-23Z'], 'deadline-receipt-tender-time-lot': ['12:00:00Z'] }))).submissionDeadline, '2026-10-23T14:00:00');
  assert.equal(mapTedNotice(item(notice({ 'deadline-receipt-tender-date-lot': ['2026-10-23+00:00'], 'deadline-receipt-tender-time-lot': ['23:30:00+00:00'] }))).submissionDeadline, '2026-10-24T01:30:00', 'a late evening deadline can fall on the next day locally');
  assert.equal(mapTedNotice(item(notice({ 'deadline-receipt-tender-date-lot': ['2026-10-23'], 'deadline-receipt-tender-time-lot': ['12:00:00'] }))).submissionDeadline, '2026-10-23T12:00:00', 'no offset at all: taken as local');
  assert.equal(mapTedNotice(item(notice({ 'estimated-value-proc': 'niet-een-getal' }))).estimatedValue?.amount, 250000, 'an unusable procedure value falls back to the lots');
});

test('everything optional missing: a minimal notice still maps', () => {
  const facts = mapTedNotice(item({ 'publication-number': '1-2026' }));
  assert.equal(facts.tenderIdentity, 'publicatie-1-2026');
  for (const key of ['title', 'contractingAuthority', 'noticeType', 'procedureType', 'contractType', 'publicationDate', 'submissionDeadline', 'estimatedValue', 'description', 'location']) assert.equal(facts[key], null, key);
  assert.deepEqual([facts.cpvCodes, facts.nutsCodes], [[], []]);
  assert.equal(mapTedNotice(item({})), null);
});

test('language choice: Dutch first, else English, else the first available; titles fall back from procedure to lot to notice title', () => {
  assert.equal(mapTedNotice(item(notice({ 'title-proc': { eng: 'Road works', nld: 'Wegwerkzaamheden', fra: 'Travaux' } }))).title, 'Wegwerkzaamheden');
  assert.equal(mapTedNotice(item(notice({ 'title-proc': { fra: 'Travaux', eng: 'Road works' } }))).title, 'Road works');
  assert.equal(mapTedNotice(item(notice({ 'title-proc': { fra: 'Travaux', deu: 'Bauarbeiten' } }))).title, 'Travaux');
  assert.equal(mapTedNotice(item(notice({ 'title-proc': undefined, 'title-lot': { eng: ['Lot title'], nld: ['Perceeltitel', 'Tweede'] } }))).title, 'Perceeltitel');
  assert.equal(mapTedNotice(item(notice({ 'title-proc': undefined, 'title-lot': undefined, 'notice-title': { eng: 'Netherlands – Services – X' } }))).title, 'Netherlands – Services – X');
  assert.equal(mapTedNotice(item(notice({ 'buyer-name': { eng: ['The Municipality'], nld: ['Gemeente Voorbeeld'] } }))).contractingAuthority, 'Gemeente Voorbeeld');
  assert.equal(mapTedNotice(item(notice({ 'description-proc': { eng: 'English text' } }))).description, 'English text');
  assert.deepEqual(pickLanguage({ nld: [], eng: ['x'] }), ['x'], 'an empty Dutch entry does not win');
  assert.deepEqual(pickLanguage({ mul: ['Neutral'] }), ['Neutral']);
  assert.deepEqual(pickLanguage(null), []);
});

test('several buyers (a joint procurement) are all named, once each', () => {
  assert.equal(mapTedNotice(item(notice({ 'buyer-name': { nld: ['Gemeente Venray', 'Gemeente Bergen', 'Gemeente Venray'] } }))).contractingAuthority, 'Gemeente Venray; Gemeente Bergen');
});

test('codes become readable labels; an unknown code is kept as it is', () => {
  const facts = mapTedNotice(item(notice({ 'notice-type': 'can-standard', 'procedure-type': 'neg-w-call', 'contract-nature': ['works', 'services'] })));
  assert.deepEqual([facts.noticeTypeLabel, facts.procedureType, facts.contractType], ['Aankondiging van een gegunde opdracht', 'Mededingingsprocedure met onderhandeling', 'Werken / Diensten']);
  const odd = mapTedNotice(item(notice({ 'notice-type': 'brand-new-type', 'procedure-type': 'something-else', 'contract-nature': ['other'] })));
  assert.deepEqual([odd.noticeTypeLabel, odd.procedureType, odd.contractType], ['brand-new-type', 'something-else', 'other']);
});

test('identity: the procedure ties the notices of one tender together; without one the notice, then the publication, identifies it', () => {
  const cn = mapTedNotice(item(notice({ 'publication-number': '600001-2026', 'procedure-identifier': 'proc-A' })));
  const can = mapTedNotice(item(notice({ 'publication-number': '650001-2026', 'notice-type': 'can-standard', 'procedure-identifier': 'proc-A' })));
  assert.equal(tenderIdentityKey(cn), 'ted|proc-A');
  assert.equal(tenderIdentityKey(cn), tenderIdentityKey(can));
  assert.equal(mapTedNotice(item(notice({ 'procedure-identifier': undefined, 'notice-identifier': 'nid-1' }))).tenderIdentity, 'nid-1');
  assert.equal(mapTedNotice(item(notice({ 'procedure-identifier': undefined, 'notice-identifier': undefined, 'publication-number': '7-2026' }))).tenderIdentity, 'publicatie-7-2026');
});

test('provenance per TED publication: a contract notice and its award notice are ONE tender with two publications, each with its own link', () => {
  const cn = mapTedNotice(item(notice({ 'publication-number': '600001-2026', 'procedure-identifier': 'proc-A', 'publication-date': '2026-09-01+02:00' })));
  const can = mapTedNotice(item(notice({ 'publication-number': '650001-2026', 'notice-type': 'can-standard', 'procedure-identifier': 'proc-A', 'publication-date': '2026-09-20+02:00', 'deadline-receipt-tender-date-lot': undefined, 'deadline-receipt-tender-time-lot': undefined })));
  const [tender, ...rest] = mergeTenderPublications([can, cn]);
  assert.equal(rest.length, 0);
  assert.deepEqual(tender.publications.map(p => [p.publicationId, p.noticeType, p.sourceUrl]), [
    ['600001-2026', 'cn-standard', 'https://ted.europa.eu/nl/notice/-/detail/600001-2026'], ['650001-2026', 'can-standard', 'https://ted.europa.eu/nl/notice/-/detail/650001-2026'],
  ]);
  assert.equal(tender.publicationId, '650001-2026');
  assert.equal(tender.noticeType, 'can-standard');
  assert.equal(tender.submissionDeadline, '2026-10-29T10:00:00', 'the award notice has no deadline: the earlier one stays');
});

test('a TED notice and a TenderNed publication of what looks like the same tender are NEVER the same identity', () => {
  const ted = mapTedNotice(item(notice({ 'procedure-identifier': '567798' })));
  const nl = mapTenderNedPublication({ externalId: '1', sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/1', fetchedAt: 'x', raw: { list: { publicatieId: '1', kenmerk: 567798 }, detail: null, detailError: null } });
  assert.notEqual(tenderIdentityKey(ted), tenderIdentityKey(nl));
  assert.equal(mergeTenderPublications([ted, nl]).length, 2);
});
