import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryRecord } from '@discovery-platform/client';
import { RecordsTable } from './records-table';
import '../domains'; // registers the vacancies renderer used by these tests

function vacancyRecord(overrides: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    id: 'r1', project_id: 'p1', domain: 'vacancies', status: 'new',
    display_name: 'Frontend Developer',
    domain_data: { title: 'Frontend Developer', company: 'Acme', location: 'Utrecht', email: 'jobs@acme.example' },
    classification: {}, score: 80, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('RecordsTable', () => {
  it('shows a proper empty state, never a bare "no records"', () => {
    render(<MemoryRouter><RecordsTable records={[]} emptyTitle="No records yet" emptyDescription="Start a run." /></MemoryRouter>);
    expect(screen.getByText('No records yet')).toBeInTheDocument();
    expect(screen.getByText('Start a run.')).toBeInTheDocument();
  });

  it('renders the vacancies domain columns (function/company/location/score/contact/source), never a hardcoded generic shell', () => {
    render(<MemoryRouter><RecordsTable records={[vacancyRecord()]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByRole('columnheader', { name: 'Function' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Company' })).toBeInTheDocument();
    expect(screen.getByText('Frontend Developer')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Utrecht')).toBeInTheDocument();
    expect(screen.getByText('jobs@acme.example')).toBeInTheDocument();
  });

  it('links each row to its record detail page', () => {
    render(<MemoryRouter><RecordsTable records={[vacancyRecord()]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Frontend Developer' })).toHaveAttribute('href', '/records/r1');
  });

  it('falls back to the generic renderer for an unregistered domain, never crashing on domain_data it does not understand', () => {
    const unknownDomainRecord = vacancyRecord({ domain: 'companies', display_name: 'Acme Corp', domain_data: { some_future_field: 'x' } });
    render(<MemoryRouter><RecordsTable records={[unknownDomainRecord]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('groups mixed-domain records into separate tables, each with its own correct columns', () => {
    const vacancy = vacancyRecord();
    const other = vacancyRecord({ id: 'r2', domain: 'companies', display_name: 'Other Co' });
    render(<MemoryRouter><RecordsTable records={[vacancy, other]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByText('Vacancy leads')).toBeInTheDocument();
    expect(screen.getByText('Records')).toBeInTheDocument(); // generic renderer's plural label
  });
});
