import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTenderNedPublication, mergeTenderPublications, tenderIdentityKey, storedTenderIdentityKey, tenderCompletenessScore } from '../dist/index.js';

const item = (list, detail = null, extra = {}) => ({
  externalId: String(list.publicatieId), sourceUrl: `https://www.tenderned.nl/aankondigingen/overzicht/${list.publicatieId}`, fetchedAt: '2026-09-21T12:00:00.000Z',
  raw: { list, detail, detailError: null }, ...extra,
});
// The shape of a real TenderNed list entry and detail document (values shortened).
const REAL_LIST = {
  publicatieId: '440769', publicatieDatum: '2026-09-21', typePublicatie: { code: 'AAO', omschrijving: 'Aankondiging opdracht' },
  aanbestedingNaam: 'Raamovereenkomst Bosbouw en Groenwerk Gelderland 2027', opdrachtgeverNaam: 'Staatsbosbeheer', sluitingsDatum: '2026-11-02T08:00:00',
  procedure: { code: 'OPE', omschrijving: 'Openbaar' }, typeOpdracht: { code: 'D', omschrijving: 'Diensten' }, europees: true,
  opdrachtBeschrijving: 'Staatsbosbeheer  wenst\nraamovereenkomsten te sluiten.', kenmerk: 567798,
};
const REAL_DETAIL = {
  publicatieId: 440769, kenmerk: 567798, referentieNummer: 'P24-195', publicatieDatum: '2026-09-21T20:22:05.307824',
  cpvCodes: [{ isHoofdOpdracht: true, code: '77000000-0', omschrijving: 'Diensten voor land-, bos- en tuinbouw' }, { isHoofdOpdracht: false, code: '77200000-2', omschrijving: 'Bosbouw' }],
  nutsCodes: [{ code: 'NL22', omschrijving: 'Gelderland' }],
};

test('mapping JSON -> TenderFacts: every field of the minimal record', () => {
  const facts = mapTenderNedPublication(item(REAL_LIST, REAL_DETAIL));
  assert.deepEqual(facts, {
    sourceSystem: 'tenderned', tenderIdentity: '567798', publicationId: '440769',
    title: 'Raamovereenkomst Bosbouw en Groenwerk Gelderland 2027', contractingAuthority: 'Staatsbosbeheer', referenceNumber: 'P24-195',
    noticeType: 'AAO', noticeTypeLabel: 'Aankondiging opdracht', procedureType: 'Openbaar', contractType: 'Diensten',
    cpvCodes: [{ code: '77000000', description: 'Diensten voor land-, bos- en tuinbouw', main: true }, { code: '77200000', description: 'Bosbouw', main: false }],
    nutsCodes: [{ code: 'NL22', description: 'Gelderland' }], location: 'Gelderland',
    publicationDate: '2026-09-21', submissionDeadline: '2026-11-02T08:00:00', estimatedValue: null,
    description: 'Staatsbosbeheer wenst raamovereenkomsten te sluiten.',
    sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440769',
    publications: [{ publicationId: '440769', noticeType: 'AAO', noticeTypeLabel: 'Aankondiging opdracht', publicationDate: '2026-09-21', submissionDeadline: '2026-11-02T08:00:00', sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440769' }],
  });
});

test('missing optional fields: nothing is invented, absent things are null or empty, and the record is still valid', () => {
  const minimal = mapTenderNedPublication(item({ publicatieId: 7, kenmerk: 99 }));
  assert.equal(minimal.tenderIdentity, '99');
  assert.equal(minimal.publicationId, '7');
  for (const key of ['title', 'contractingAuthority', 'referenceNumber', 'noticeType', 'procedureType', 'contractType', 'location', 'publicationDate', 'submissionDeadline', 'estimatedValue', 'description']) {
    assert.equal(minimal[key], null, key);
  }
  assert.deepEqual(minimal.cpvCodes, []);
  assert.deepEqual(minimal.nutsCodes, []);
  assert.equal(minimal.publications.length, 1);
  assert.equal(tenderCompletenessScore(minimal).score, 0);
  // Detail present but with wrong types / junk entries.
  const junk = mapTenderNedPublication(item({ publicatieId: 8, kenmerk: 1, aanbestedingNaam: 42, opdrachtgeverNaam: {}, sluitingsDatum: null },
    { cpvCodes: 'x', nutsCodes: [null, { code: '' }, { code: 'NL11' }], referentieNummer: ['a'], geraamdeWaarde: 'veel' }));
  assert.equal(junk.title, '42');
  assert.equal(junk.contractingAuthority, null);
  assert.deepEqual(junk.cpvCodes, []);
  assert.deepEqual(junk.nutsCodes, [{ code: 'NL11', description: null }]);
  assert.equal(junk.location, null);
  assert.equal(junk.estimatedValue, null);
});

test('a publication without an id is not mappable; one without a kenmerk becomes its own tender', () => {
  assert.equal(mapTenderNedPublication(item({ aanbestedingNaam: 'x' })), null);
  const own = mapTenderNedPublication(item({ publicatieId: 55 }));
  assert.equal(own.tenderIdentity, 'publicatie-55');
});

test('an estimated value is only taken when the source states one explicitly', () => {
  assert.deepEqual(mapTenderNedPublication(item({ publicatieId: 1, kenmerk: 1 }, { geraamdeWaarde: 250000 })).estimatedValue, { amount: 250000, currency: 'EUR' });
  assert.deepEqual(mapTenderNedPublication(item({ publicatieId: 1, kenmerk: 1 }, { geschatteWaarde: { bedrag: 1200.5, valuta: 'EUR' } })).estimatedValue, { amount: 1200.5, currency: 'EUR' });
  assert.equal(mapTenderNedPublication(item({ publicatieId: 1, kenmerk: 1 }, REAL_DETAIL)).estimatedValue, null);
});

test('the list entry alone (detail missing or failed) still gives a usable tender', () => {
  const facts = mapTenderNedPublication({ ...item(REAL_LIST), raw: { list: REAL_LIST, detail: null, detailError: 'timeout: x' } });
  assert.equal(facts.title, 'Raamovereenkomst Bosbouw en Groenwerk Gelderland 2027');
  assert.deepEqual(facts.cpvCodes, []);
  assert.equal(facts.referenceNumber, null);
  assert.equal(facts.submissionDeadline, '2026-11-02T08:00:00');
});

// ─── tender identity: kenmerk; publication identity: publicatieId ─────────────────────────────────────

test('two publications with the same kenmerk are ONE tender: merged, all publications kept, later values win, gaps are filled from earlier ones', () => {
  const announcement = mapTenderNedPublication(item(REAL_LIST, REAL_DETAIL));
  const correction = mapTenderNedPublication(item({
    publicatieId: '440900', publicatieDatum: '2026-09-23', typePublicatie: { code: 'REC', omschrijving: 'Rectificatie' }, kenmerk: 567798,
    aanbestedingNaam: 'Raamovereenkomst Bosbouw en Groenwerk Gelderland 2027 (gecorrigeerd)', opdrachtgeverNaam: 'Staatsbosbeheer', sluitingsDatum: '2026-11-16T08:00:00',
  }));
  const [tender, ...rest] = mergeTenderPublications([correction, announcement]);
  assert.equal(rest.length, 0);
  assert.equal(tender.tenderIdentity, '567798');
  assert.deepEqual(tender.publications.map(p => [p.publicationId, p.noticeType]), [['440769', 'AAO'], ['440900', 'REC']]);
  assert.equal(tender.publicationId, '440900', 'describes the latest publication');
  assert.equal(tender.noticeType, 'REC');
  assert.equal(tender.publicationDate, '2026-09-23');
  assert.equal(tender.title, 'Raamovereenkomst Bosbouw en Groenwerk Gelderland 2027 (gecorrigeerd)');
  assert.equal(tender.submissionDeadline, '2026-11-16T08:00:00', 'the correction restates the deadline');
  assert.equal(tender.cpvCodes.length, 2, 'CPV codes only the announcement had are kept');
  assert.equal(tender.referenceNumber, 'P24-195');
  assert.equal(tender.description, 'Staatsbosbeheer wenst raamovereenkomsten te sluiten.');
  assert.equal(tender.location, 'Gelderland');
});

test('merging is order independent, lists a publication id once, and keeps different tenders apart', () => {
  const a1 = mapTenderNedPublication(item({ publicatieId: 1, kenmerk: 10, publicatieDatum: '2026-09-01' }));
  const a2 = mapTenderNedPublication(item({ publicatieId: 2, kenmerk: 10, publicatieDatum: '2026-09-05' }));
  const b1 = mapTenderNedPublication(item({ publicatieId: 3, kenmerk: 11, publicatieDatum: '2026-09-02' }));
  const forward = mergeTenderPublications([a1, b1, a2, a1]);
  const backward = mergeTenderPublications([a2, a1, b1]);
  assert.equal(forward.length, 2);
  assert.deepEqual(forward.map(t => t.tenderIdentity), ['10', '11']);
  assert.deepEqual(forward[0].publications.map(p => p.publicationId), ['1', '2']);
  assert.deepEqual(forward[0], backward.find(t => t.tenderIdentity === '10'));
  // The same kenmerk in another source system is another tender.
  const other = { ...a1, sourceSystem: 'other-source' };
  assert.equal(mergeTenderPublications([a1, other]).length, 2);
});

test('stable dedupe key: source system + kenmerk, identical for every publication of a tender and for a stored record', () => {
  const a1 = mapTenderNedPublication(item({ publicatieId: 1, kenmerk: 10 }));
  const a2 = mapTenderNedPublication(item({ publicatieId: 2, kenmerk: 10, aanbestedingNaam: 'Andere titel' }));
  const b = mapTenderNedPublication(item({ publicatieId: 3, kenmerk: 11 }));
  assert.equal(tenderIdentityKey(a1), 'tenderned|10');
  assert.equal(tenderIdentityKey(a1), tenderIdentityKey(a2));
  assert.notEqual(tenderIdentityKey(a1), tenderIdentityKey(b));
  assert.equal(storedTenderIdentityKey(JSON.parse(JSON.stringify(mergeTenderPublications([a1, a2])[0]))), 'tenderned|10');
  assert.equal(storedTenderIdentityKey({ title: 'a vacancy', company: 'x' }), null);
  assert.equal(storedTenderIdentityKey({ sourceSystem: 'tenderned' }), null);
});

test('completeness score weighs the fields and reports what is present and missing', () => {
  const full = mapTenderNedPublication(item(REAL_LIST, REAL_DETAIL));
  const { score, presentSignals, missingSignals } = tenderCompletenessScore(full);
  assert.equal(score, 95);
  assert.deepEqual(missingSignals, ['estimatedValue']);
  assert.ok(presentSignals.includes('cpvCodes'));
  assert.ok(tenderCompletenessScore(mapTenderNedPublication(item(REAL_LIST))).score < score);
});
