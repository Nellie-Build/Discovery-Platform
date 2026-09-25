import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryRecord } from '@discovery-platform/client';
import { RecordsTable } from '../../components/records-table';
import '../index';

/** The three video tenders of 2026-09-24 as six stored source records; TenderNed states each TED publication number. */
const created = '2026-09-24T21:01:56.930Z';
const leerdam = 'Gemeente Vijfheerenlanden - Audiovisuele Apparatuur Raadzaal Leerdam';
const campaign = 'Raamovereenkomst campagneontwikkeling, mediastrategie en media-inkoop';
const narrowcasting = 'Audiovisuele middelen en Narrowcasting';
const tn = (id: string) => `https://www.tenderned.nl/aankondigingen/overzicht/${id}`;
const ted = (number: string) => `https://ted.europa.eu/nl/notice/-/detail/${number}`;
function record(id: string, sourceSystem: string, title: string, noticeType: string, noticeTypeLabel: string, deadline: string | null, publicationId: string, sourceUrl: string, tedPublicationNumber?: string): DiscoveryRecord {
  const publication = { publicationId, noticeType, noticeTypeLabel, publicationDate: '2026-09-20', submissionDeadline: deadline, sourceUrl, ...(tedPublicationNumber ? { tedPublicationNumber } : {}) };
  return {
    id, project_id: 'p1', domain: 'tenders', status: 'new', display_name: title, classification: { presentSignals: ['title'], missingSignals: [] }, score: 80, created_at: created, updated_at: created,
    domain_data: { sourceSystem, tenderIdentity: id, publicationId, title, contractingAuthority: sourceSystem === 'ted' ? 'Vijfheerenlanden (TED)' : 'Gemeente Vijfheerenlanden', noticeType, noticeTypeLabel, procedureType: null, submissionDeadline: deadline, sourceUrl, cpvCodes: [], nutsCodes: [], location: null, publications: [publication] },
  } as DiscoveryRecord;
}
const SIX = [
  record('tn-612851', 'tenderned', leerdam, 'AAO', 'Aankondiging opdracht', '2026-11-16T10:00:00', '440454', tn('440454'), '643394-2026'),
  record('ted-narrow', 'ted', narrowcasting, 'can-standard', 'Aankondiging van een gegunde opdracht', null, '655158-2026', ted('655158-2026')),
  record('tn-610084', 'tenderned', narrowcasting, 'AGO', 'Aankondiging gegunde opdracht', null, '441064', tn('441064'), '655158-2026'),
  record('tn-613688', 'tenderned', campaign, 'AAO', 'Aankondiging opdracht', '2026-10-22T23:59:00', '440953', tn('440953'), '654717-2026'),
  record('ted-leerdam', 'ted', leerdam, 'cn-standard', 'Aankondiging van een opdracht', '2026-11-16T10:00:00', '643394-2026', ted('643394-2026')),
  record('ted-campaign', 'ted', campaign, 'cn-standard', 'Aankondiging van een opdracht', null, '654717-2026', ted('654717-2026')),
];
const rowOf = (title: string) => screen.getAllByRole('row').find(row => row.textContent?.includes(title))!;

describe('linked TED and TenderNed records', () => {
  it('six source records are three tenders in the list, each with both source links', () => {
    render(<MemoryRouter><RecordsTable records={SIX} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getAllByRole('row')).toHaveLength(1 + 3);
    for (const [title, links] of [[leerdam, [tn('440454'), ted('643394-2026')]], [campaign, [tn('440953'), ted('654717-2026')]], [narrowcasting, [tn('441064'), ted('655158-2026')]]] as const) {
      const row = within(rowOf(title));
      expect(row.getByText('TenderNed + TED')).toBeInTheDocument();
      expect(row.getByRole('link', { name: 'TenderNed ↗' })).toHaveAttribute('href', links[0]);
      expect(row.getByRole('link', { name: 'TED ↗' })).toHaveAttribute('href', links[1]);
    }
  });

  it('the campaign tender shows the TenderNed deadline, named as TenderNed\'s, and TED as stating none', () => {
    render(<MemoryRouter><RecordsTable records={SIX} emptyTitle="unused" /></MemoryRouter>);
    const row = within(rowOf(campaign));
    const columns = screen.getAllByRole('columnheader').map(header => header.textContent);
    const deadlineCell = row.getAllByRole('cell')[columns.indexOf('Sluitingsdatum')];
    expect(deadlineCell.textContent).toMatch(/22.*10.*2026|22 okt/);
    expect(deadlineCell.textContent).toContain('volgens TenderNed');
    expect(row.getByText('geen sluitingsdatum gepubliceerd')).toBeInTheDocument();
    expect(row.getByText('Open')).toBeInTheDocument();
    expect(SIX.find(r => r.id === 'ted-campaign')!.domain_data.submissionDeadline).toBeNull();
  });

  it('a record without a stated TED number stays its own row', () => {
    const unlinked = SIX.map(r => (r.domain_data.sourceSystem === 'tenderned'
      ? { ...r, domain_data: { ...r.domain_data, publications: (r.domain_data.publications as Array<Record<string, unknown>>).map(({ tedPublicationNumber: _, ...p }) => p) } }
      : r));
    render(<MemoryRouter><RecordsTable records={unlinked} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getAllByRole('row')).toHaveLength(1 + 6);
  });
});
