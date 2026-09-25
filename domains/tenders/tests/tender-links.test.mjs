import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineLinkedTenders, linkTenders, mapTenderNedPublication, tedPublicationNumbers } from '../dist/index.js';

/**
 * The three video tenders found on 2026-09-24 (NL, CPV 92111000 / 32321200), as stored: six source records, each
 * TenderNed publication stating its TED publication number (`pbNummerTed`). Values copied from the live records.
 */
const pub = (publicationId, noticeType, submissionDeadline, extra = {}) => ({ publicationId, noticeType, noticeTypeLabel: null, publicationDate: '2026-09-20', submissionDeadline, sourceUrl: `https://example.test/${publicationId}`, ...extra });
const tender = (sourceSystem, tenderIdentity, title, noticeType, submissionDeadline, publication) => ({
  sourceSystem, tenderIdentity, title, contractingAuthority: sourceSystem === 'ted' ? 'Gemeente (TED-schrijfwijze)' : 'Gemeente (TenderNed)',
  noticeType, noticeTypeLabel: null, submissionDeadline, sourceUrl: publication.sourceUrl, publications: [publication],
});
const leerdam = 'Gemeente Vijfheerenlanden - Audiovisuele Apparatuur Raadzaal Leerdam';
const campaign = 'Raamovereenkomst campagneontwikkeling, mediastrategie en media-inkoop';
const narrowcasting = 'Audiovisuele middelen en Narrowcasting';
const SIX = [
  tender('tenderned', '612851', leerdam, 'AAO', '2026-11-16T10:00:00', pub('440454', 'AAO', '2026-11-16T10:00:00', { tedPublicationNumber: '643394-2026' })),
  tender('ted', '85a050fe-fc51-4fa3-88e8-1ecfba211459', narrowcasting, 'can-standard', null, pub('655158-2026', 'can-standard', null)),
  tender('tenderned', '610084', narrowcasting, 'AGO', null, pub('441064', 'AGO', null, { tedPublicationNumber: '655158-2026' })),
  tender('tenderned', '613688', campaign, 'AAO', '2026-10-22T23:59:00', pub('440953', 'AAO', '2026-10-22T23:59:00', { tedPublicationNumber: '654717-2026' })),
  tender('ted', '70daefb4-1351-4ac1-b5f3-d45d78d20745', leerdam, 'cn-standard', '2026-11-16T10:00:00', pub('643394-2026', 'cn-standard', '2026-11-16T10:00:00')),
  tender('ted', '86d1a0e7-68c8-4ea4-9d0c-f8fe3093aa67', campaign, 'cn-standard', null, pub('654717-2026', 'cn-standard', null)),
];
const now = new Date('2026-09-25T10:00:00Z');

test('six source records of the three video tenders give three linked tenders, each with both sources', () => {
  const before = JSON.stringify(SIX);
  const groups = linkTenders(SIX);
  assert.equal(groups.length, 3);
  for (const group of groups) {
    assert.deepEqual(group.map(t => t.sourceSystem).sort(), ['ted', 'tenderned']);
    assert.equal(new Set(group.map(t => t.title)).size, 1);
  }
  assert.deepEqual(groups.map(g => g[0].title), [leerdam, narrowcasting, campaign], 'groups keep the order of their first record');
  assert.equal(JSON.stringify(SIX), before, 'linking never changes the records themselves');
});

test('the campaign tender takes its deadline from TenderNed, named as such; the TED record keeps no deadline', () => {
  const group = linkTenders(SIX).find(g => g[0].title === campaign);
  const combined = combineLinkedTenders(group, now);
  assert.deepEqual(combined.submissionDeadline, { value: '2026-10-22T23:59:00', sourceSystem: 'tenderned' });
  assert.equal(combined.status, 'open');
  const ted = combined.members.find(t => t.sourceSystem === 'ted');
  assert.equal(ted.submissionDeadline, null);
  assert.equal(ted.publications[0].submissionDeadline, null);
  assert.deepEqual(combined.members.map(t => t.sourceSystem), ['tenderned', 'ted']);
});

test('status of a linked tender: open for Leerdam, expired for the awarded narrowcasting tender', () => {
  const byTitle = Object.fromEntries(linkTenders(SIX).map(g => [g[0].title, combineLinkedTenders(g, now)]));
  assert.equal(byTitle[leerdam].status, 'open');
  assert.equal(byTitle[narrowcasting].status, 'expired');
  assert.equal(byTitle[leerdam].contractingAuthority.sourceSystem, 'tenderned');
});

test('only an explicitly stated TED number links: same title without it stays apart, a malformed number is ignored', () => {
  const withoutNumber = SIX.map(t => t.sourceSystem === 'tenderned' ? { ...t, publications: t.publications.map(({ tedPublicationNumber, ...p }) => p) } : t);
  assert.equal(linkTenders(withoutNumber).length, 6);
  const malformed = { ...SIX[0], publications: [{ ...SIX[0].publications[0], tedPublicationNumber: '643394' }] };
  assert.deepEqual(tedPublicationNumbers(malformed), []);
  const website = { sourceSystem: 'website', title: leerdam, publications: [{ publicationId: '643394-2026' }] };
  assert.equal(linkTenders([SIX[4], website]).length, 2, 'a website record is never linked by id');
});

test('the TenderNed mapping keeps pbNummerTed as the publication\'s TED number, and omits it when absent or malformed', () => {
  const item = detail => ({ sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440953', raw: { list: { publicatieId: '440953', kenmerk: 613688, aanbestedingNaam: campaign }, detail, detailError: null } });
  assert.equal(mapTenderNedPublication(item({ pbNummerTed: '654717-2026' })).publications[0].tedPublicationNumber, '654717-2026');
  assert.ok(!('tedPublicationNumber' in mapTenderNedPublication(item({})).publications[0]));
  assert.ok(!('tedPublicationNumber' in mapTenderNedPublication(item({ pbNummerTed: 'onbekend' })).publications[0]));
});

test('a record stored before the TED number existed gets it when a run sees the same TenderNed publication again', async () => {
  const { updateStoredTender } = await import('../dist/index.js');
  const incoming = { ...SIX[3], referenceNumber: null, procedureType: null, contractType: null, cpvCodes: [], nutsCodes: [], location: null, publicationDate: '2026-09-20', estimatedValue: null, description: null, publicationId: '440953' };
  const stored = { ...incoming, publications: incoming.publications.map(({ tedPublicationNumber, ...p }) => p) };
  const update = updateStoredTender(stored, incoming);
  assert.equal(update.changed, true);
  assert.equal(update.facts.publications[0].tedPublicationNumber, '654717-2026');
  assert.deepEqual(update.newPublications, [], 'the same publication, not a new one');
  assert.equal(updateStoredTender(incoming, incoming).changed, false, 'once stored, seeing it again changes nothing');
});
