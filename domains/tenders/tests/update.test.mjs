import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTenderNedPublication, mergeTenderPublications, storedTenderFacts, updateStoredTender, tenderFactsEqual } from '../dist/index.js';

const item = (list, detail = null) => ({
  externalId: String(list.publicatieId), sourceUrl: `https://www.tenderned.nl/aankondigingen/overzicht/${list.publicatieId}`, fetchedAt: '2026-09-21T12:00:00.000Z',
  raw: { list, detail, detailError: null },
});
const facts = (list, detail) => mapTenderNedPublication(item(list, detail));
const AAO = {
  publicatieId: '1', kenmerk: 500, publicatieDatum: '2026-09-19', typePublicatie: { code: 'AAO', omschrijving: 'Aankondiging opdracht' }, aanbestedingNaam: 'Tender',
  opdrachtgeverNaam: 'Gemeente X', sluitingsDatum: '2026-11-02T08:00:00', procedure: { code: 'OPE', omschrijving: 'Openbaar' }, opdrachtBeschrijving: 'Tekst.',
};
const AAO_DETAIL = { cpvCodes: [{ isHoofdOpdracht: true, code: '45000000-7', omschrijving: 'Bouw' }], nutsCodes: [{ code: 'NL33', omschrijving: 'Zuid-Holland' }], referentieNummer: 'P-1' };
const stored = () => JSON.parse(JSON.stringify(mergeTenderPublications([facts(AAO, AAO_DETAIL)])[0]));

test('a stored record reads back as facts; sparse or foreign data is completed or refused, never trusted blindly', () => {
  const read = storedTenderFacts(stored());
  assert.equal(read.tenderIdentity, '500');
  assert.equal(read.publications.length, 1);
  const sparse = storedTenderFacts({ sourceSystem: 'tenderned', tenderIdentity: '7', title: 'x' });
  assert.deepEqual([sparse.cpvCodes, sparse.nutsCodes, sparse.publications, sparse.description], [[], [], [], null]);
  assert.equal(storedTenderFacts({ title: 'a vacancy' }), null);
  assert.equal(storedTenderFacts({ sourceSystem: 'tenderned' }), null);
  assert.equal(storedTenderFacts({ sourceSystem: 'tenderned', tenderIdentity: '7', publications: 'x', cpvCodes: 5 }).publications.length, 0);
});

test('the same publication again is unchanged and adds nothing (key order is irrelevant)', () => {
  const s = storedTenderFacts(stored());
  const update = updateStoredTender(s, facts(AAO, AAO_DETAIL));
  assert.equal(update.changed, false);
  assert.deepEqual(update.newPublications, []);
  const reordered = Object.fromEntries(Object.entries(stored()).reverse());
  assert.equal(tenderFactsEqual(reordered, stored()), true);
  assert.equal(tenderFactsEqual({ a: [1, 2] }, { a: [2, 1] }), false);
});

test('announcement -> correction: added once, the latest publication describes the record, changed fields are taken over', () => {
  const correction = facts({ publicatieId: '2', kenmerk: 500, publicatieDatum: '2026-09-21', typePublicatie: { code: 'REC', omschrijving: 'Rectificatie' }, sluitingsDatum: '2026-11-16T08:00:00', procedure: { code: 'NOP', omschrijving: 'Niet-openbaar' }, opdrachtBeschrijving: 'Nieuwe tekst.' },
    { cpvCodes: [{ isHoofdOpdracht: true, code: '45100000-8', omschrijving: 'Sloop' }], nutsCodes: [{ code: 'NL34', omschrijving: 'Zeeland' }] });
  const update = updateStoredTender(storedTenderFacts(stored()), correction);
  assert.equal(update.changed, true);
  assert.deepEqual(update.newPublications.map(p => p.publicationId), ['2']);
  const f = update.facts;
  assert.deepEqual(f.publications.map(p => p.publicationId), ['1', '2']);
  assert.deepEqual([f.publicationId, f.noticeType, f.publicationDate], ['2', 'REC', '2026-09-21']);
  assert.deepEqual([f.submissionDeadline, f.procedureType, f.description, f.location], ['2026-11-16T08:00:00', 'Niet-openbaar', 'Nieuwe tekst.', 'Zeeland']);
  assert.deepEqual(f.cpvCodes.map(c => c.code), ['45100000']);
  assert.equal(f.referenceNumber, 'P-1', 'kept: the correction has no reference');
});

test('a later publication without a field keeps the earlier value; an award keeps the deadline', () => {
  const award = facts({ publicatieId: '3', kenmerk: 500, publicatieDatum: '2026-10-01', typePublicatie: { code: 'AGO', omschrijving: 'Aankondiging gegunde opdracht' } });
  const { facts: f, changed } = updateStoredTender(storedTenderFacts(stored()), award);
  assert.equal(changed, true);
  assert.deepEqual([f.noticeType, f.publicationId, f.submissionDeadline, f.description, f.contractingAuthority], ['AGO', '3', '2026-11-02T08:00:00', 'Tekst.', 'Gemeente X']);
  assert.equal(f.cpvCodes.length, 1);
});

test('an older publication fills gaps only; on the same publication id the fresh values win', () => {
  const late = facts({ publicatieId: '5', kenmerk: 500, publicatieDatum: '2026-09-25', typePublicatie: { code: 'REC', omschrijving: 'Rectificatie' }, sluitingsDatum: '2026-12-01T08:00:00' });
  const base = storedTenderFacts(JSON.parse(JSON.stringify(mergeTenderPublications([facts(AAO, AAO_DETAIL), late])[0])));
  const older = facts({ publicatieId: '3', kenmerk: 500, publicatieDatum: '2026-09-20', typePublicatie: { code: 'REC', omschrijving: 'Rectificatie' }, sluitingsDatum: '2026-11-09T08:00:00', aanbestedingNaam: 'Titel uit publicatie 3' });
  const filled = updateStoredTender(base, older).facts;
  assert.equal(filled.publicationId, '5');
  assert.equal(filled.submissionDeadline, '2026-12-01T08:00:00', 'the newer publication keeps its say');
  assert.deepEqual(filled.publications.map(p => p.publicationId), ['1', '3', '5']);
  const changedSame = updateStoredTender(storedTenderFacts(stored()), facts({ ...AAO, opdrachtBeschrijving: 'Bijgewerkt.' }, AAO_DETAIL));
  assert.equal(changedSame.changed, true);
  assert.equal(changedSame.facts.description, 'Bijgewerkt.');
  assert.deepEqual(changedSame.newPublications, []);
});
