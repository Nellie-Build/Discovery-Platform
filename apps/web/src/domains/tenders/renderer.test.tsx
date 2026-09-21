import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveryRecord, RecordWithDetails } from '@discovery-platform/client';
import { RecordsTable } from '../../components/records-table';
import { RecordDetailPage } from '../../pages/record-detail';
import { getDomainRenderer } from '../registry';
import { formatTenderDate, isUpdatedRecord } from './renderer';
import '../index';

const useAsyncMock = vi.fn();
vi.mock('../../hooks/use-async', () => ({ useAsync: (...args: unknown[]) => useAsyncMock(...args) }));

const created = '2026-09-20T10:00:00.000Z';
const facts = {
  sourceSystem: 'tenderned', tenderIdentity: '609324', publicationId: '440779', title: 'Transport en verwerking groenstromen', contractingAuthority: 'KAREL.',
  referenceNumber: 'KAR-26-01', noticeType: 'REC', noticeTypeLabel: 'Rectificatie', procedureType: 'Openbaar', contractType: 'Diensten',
  cpvCodes: [{ code: '90510000', description: 'Afvalverwerking', main: true }, { code: '90500000', description: 'Afval', main: false }],
  nutsCodes: [{ code: 'NL411', description: 'West-Noord-Brabant' }, { code: 'NL415', description: 'Zuidoost-Noord-Brabant' }],
  location: 'West-Noord-Brabant, Zuidoost-Noord-Brabant', publicationDate: '2026-09-21', submissionDeadline: '2026-10-29T10:00:00', estimatedValue: null,
  description: 'Het inzamelen en verwerken van groenstromen.', sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440779',
  publications: [
    { publicationId: '440664', noticeType: 'AAO', noticeTypeLabel: 'Aankondiging opdracht', publicationDate: '2026-09-20', submissionDeadline: '2026-10-16T10:00:00', sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440664' },
    { publicationId: '440779', noticeType: 'REC', noticeTypeLabel: 'Rectificatie', publicationDate: '2026-09-21', submissionDeadline: '2026-10-29T10:00:00', sourceUrl: 'https://www.tenderned.nl/aankondigingen/overzicht/440779' },
  ],
};
function tenderRecord(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return { id: 't1', project_id: 'p1', domain: 'tenders', status: 'new', display_name: facts.title, domain_data: facts, classification: { presentSignals: ['title'], missingSignals: ['estimatedValue'] }, score: 95, created_at: created, updated_at: created, ...overrides };
}
const withDetails = (record: DiscoveryRecord): RecordWithDetails => ({
  ...record,
  sources: [{ id: 's1', record_id: record.id, source_type: 'api', source_url: facts.sourceUrl, source_label: 'tenderned', source_data: {}, discovered_at: created }],
  contacts: [],
});

describe('tender renderer', () => {
  it('is registered next to vacancies and the list shows the tender columns', () => {
    expect(getDomainRenderer('tenders').recordLabelPlural).toBe('Tenders');
    render(<MemoryRouter><RecordsTable records={[tenderRecord()]} emptyTitle="unused" /></MemoryRouter>);
    for (const header of ['Aanbesteding', 'Aanbestedende dienst', 'Sluitingsdatum', 'Procedure', 'CPV', 'Locatie / NUTS', 'Laatste publicatie']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const row = screen.getByRole('row', { name: /Transport en verwerking groenstromen/ });
    expect(within(row).getByText('KAREL.')).toBeInTheDocument();
    expect(within(row).getByText('29-10-2026 10:00')).toBeInTheDocument();
    expect(within(row).getByText('Openbaar')).toBeInTheDocument();
    expect(within(row).getByText(/90510000 · Afvalverwerking \(\+1\)/)).toBeInTheDocument();
    expect(within(row).getByText(/West-Noord-Brabant, Zuidoost-Noord-Brabant \(NL411, NL415\)/)).toBeInTheDocument();
    expect(within(row).getByText('Rectificatie')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /Transport en verwerking groenstromen/ })).toHaveAttribute('href', '/records/t1');
  });

  it('marks an updated record in the list, but not a fresh one', () => {
    const { rerender } = render(<MemoryRouter><RecordsTable records={[tenderRecord()]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.queryByText('Bijgewerkt')).not.toBeInTheDocument();
    rerender(<MemoryRouter><RecordsTable records={[tenderRecord({ updated_at: '2026-09-21T10:00:00.000Z' })]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByText('Bijgewerkt')).toBeInTheDocument();
  });

  it('a sparse record (everything optional missing) renders placeholders instead of crashing', () => {
    render(<MemoryRouter><RecordsTable records={[tenderRecord({ display_name: null, domain_data: { sourceSystem: 'tenderned', tenderIdentity: '1' } })]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(6);
  });

  it('formats dates as published and detects updates', () => {
    expect(formatTenderDate('2026-11-02T08:00:00')).toBe('02-11-2026 08:00');
    expect(formatTenderDate('2026-09-21')).toBe('21-09-2026');
    expect(formatTenderDate(null)).toBeNull();
    expect(isUpdatedRecord({ created_at: created, updated_at: created })).toBe(false);
    expect(isUpdatedRecord({ created_at: created, updated_at: '2026-09-21T10:00:00.000Z' })).toBe(true);
  });
});

function renderDetail(record: RecordWithDetails) {
  useAsyncMock.mockReturnValue({ loading: false, error: null, refetch: vi.fn(), data: record });
  return render(<MemoryRouter initialEntries={['/records/t1']}><Routes><Route path="/records/:id" element={<RecordDetailPage />} /></Routes></MemoryRouter>);
}

describe('tender record detail', () => {
  it('shows every TenderFacts field, the source link and the publication history (newest first)', () => {
    renderDetail(withDetails(tenderRecord()));
    for (const label of ['Aanbesteding', 'Aanbestedende dienst', 'Kenmerk (tender-identiteit)', 'Bron', 'Referentienummer', 'Laatste publicatie-ID', 'Publicatietype', 'Procedure', 'Soort opdracht',
      'CPV-codes', 'NUTS', 'Locatie', 'Publicatiedatum', 'Sluitingsdatum', 'Geraamde waarde', 'Beschrijving', 'Bronlink']) {
      expect(screen.getByText(label, { selector: 'dt' })).toBeInTheDocument();
    }
    expect(screen.getByText('609324')).toBeInTheDocument();
    expect(screen.getByText('KAR-26-01')).toBeInTheDocument();
    expect(screen.getByText(/90510000 · Afvalverwerking \(hoofd\)/)).toBeInTheDocument();
    expect(screen.getByText(/NL415 · Zuidoost-Noord-Brabant/)).toBeInTheDocument();
    expect(screen.getByText('29-10-2026 10:00', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Het inzamelen en verwerken van groenstromen.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: facts.sourceUrl });
    expect(links[0]).toHaveAttribute('href', facts.sourceUrl);

    const history = screen.getByRole('list', { name: 'Publicaties' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Rectificatie');
    expect(items[0]).toHaveTextContent('440779');
    expect(items[0]).toHaveTextContent('Laatste');
    expect(items[0]).toHaveTextContent('sluiting 29-10-2026 10:00');
    expect(items[1]).toHaveTextContent('Aankondiging opdracht');
    expect(items[1]).toHaveTextContent('sluiting 16-10-2026 10:00');
  });

  it('says clearly that a record was updated later — and says nothing of the sort for a record that was not', () => {
    const { unmount } = renderDetail(withDetails(tenderRecord({ updated_at: '2026-09-21T10:00:00.000Z' })));
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Bijgewerkt op');
    expect(notice).toHaveTextContent('Laatste publicatie: Rectificatie (21-09-2026); 2 publicaties in totaal.');
    unmount();
    renderDetail(withDetails(tenderRecord()));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a record without publications or optional fields still renders', () => {
    renderDetail(withDetails(tenderRecord({ domain_data: { sourceSystem: 'tenderned', tenderIdentity: '9' } })));
    expect(screen.getByText('Geen publicaties vastgelegd.')).toBeInTheDocument();
  });
});

describe('the generic web components stay free of tender vocabulary', () => {
  it('records-table, record-detail, project-detail, projects and the registry never mention tender-specific fields', () => {
    const files = ['components/records-table.tsx', 'pages/record-detail.tsx', 'pages/project-detail.tsx', 'domains/registry.tsx', 'components/run-status-card.tsx'];
    const offenders: string[] = [];
    for (const file of files) {
      const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const pattern of [/tenderned/i, /\bcpv/i, /\bnuts/i, /kenmerk/i, /aanbesteding/i, /submissionDeadline/i, /contractingAuthority/i]) if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });
});
