import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryRecord, DiscoveryRun, RecordWithDetails } from '@discovery-platform/client';
import { RecordsTable } from '../../components/records-table';
import { getDomainRenderer } from '../registry';
import { CompanyRunPanel, CompanyRunSummary, buildCompanyRunRequest, defaultCompanyRunFields } from './run-panel';
import '../index';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

const checked = '2026-09-26T10:00:00.000Z';
const record = (id: string, types: Array<{ type: string; strength: string }>, over: Record<string, unknown> = {}): DiscoveryRecord => ({
  id, project_id: 'p1', domain: 'companies', status: 'new', display_name: id, classification: {}, score: null, created_at: checked, updated_at: checked,
  domain_data: {
    identity: `${id}.example`, domain: `${id}.example`, website: `https://${id}.example/`, tradeNames: [], industries: [], products: [], services: [], specialisations: [], customerSectors: [], roles: [],
    businessTypes: types.map(t => ({ ...t, signals: ['winkelwagen'], sourceUrl: `https://${id}.example/`, quote: null })), locations: [], serviceAreas: [], sources: [], changes: [], lastCheckedAt: checked,
    registration: { kvkNumber: null, statedKvkNumber: null, statedOn: null }, search: { criteria: 'x', status: 'possible', matches: [], checkedAt: checked }, ...over,
  },
} as DiscoveryRecord);
const run = (id: string, stats: Record<string, unknown>) => ({ id, project_id: 'p1', status: 'partial', error: null, stats, created_at: checked } as unknown as DiscoveryRun);

describe('companies quality in the web app', () => {
  beforeEach(() => {
    vi.mocked(api.runs.listByProject).mockReset();
    vi.mocked(api.runs.continueRun).mockReset();
  });

  it('offers the next batch of the latest search that left candidates, and starts it with the run id only', async () => {
    const first = run('run-1', { continuation: { cursor: '…', remaining: 7 } });
    vi.mocked(api.runs.listByProject).mockResolvedValue([first]);
    const next = run('run-2', { continuesRunId: 'run-1', batch: 2 });
    vi.mocked(api.runs.continueRun).mockResolvedValue(next);
    const onStarted = vi.fn();
    render(<CompanyRunPanel projectId="p1" onStarted={onStarted} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Volgende batch onderzoeken (7 kandidaten)' }));
    expect(api.runs.continueRun).toHaveBeenCalledWith('p1', 'run-1');
    expect(onStarted).toHaveBeenCalledWith(next);
  });

  it('does not offer a batch for a run that was already continued', async () => {
    vi.mocked(api.runs.listByProject).mockResolvedValue([run('run-2', { continuesRunId: 'run-1' }), run('run-1', { continuation: { cursor: '…', remaining: 7 } })]);
    render(<CompanyRunPanel projectId="p1" onStarted={vi.fn()} />);
    await waitFor(() => expect(api.runs.listByProject).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Volgende batch/ })).not.toBeInTheDocument();
  });

  it('business type is an optional criterion; nothing checked means every type, web shops included', () => {
    const plain = buildCompanyRunRequest({ ...defaultCompanyRunFields(), products: 'camerasystemen' });
    expect(plain).toHaveProperty('request');
    expect((plain as { request: { filters: Record<string, unknown> } }).request.filters).not.toHaveProperty('businessTypes');
    const b2b = buildCompanyRunRequest({ ...defaultCompanyRunFields(), products: 'camerasystemen', businessTypes: ['b2b_supplier'] });
    expect((b2b as { request: { filters: Record<string, unknown> } }).request.filters.businessTypes).toEqual(['b2b_supplier']);
  });

  it('the list shows each company\'s business types and filters on them', async () => {
    render(<MemoryRouter><RecordsTable records={[record('shop', [{ type: 'consumer_webshop', strength: 'strong' }]), record('groothandel', [{ type: 'b2b_supplier', strength: 'strong' }, { type: 'distributor', strength: 'strong' }])]} emptyTitle="unused" /></MemoryRouter>);
    expect(within(screen.getByRole('row', { name: /groothandel/ })).getByText('Zakelijke leverancier · Distributeur')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Type bedrijf'), 'consumer_webshop');
    expect(screen.getByText('1 van 2 bedrijven')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /groothandel/ })).not.toBeInTheDocument();
  });

  it('related evidence is shown as a lead, never as the proven activity', () => {
    const related = record('bouw', [], { specialisations: [{ kind: 'specialisation', conceptId: 'school_renovation', label: 'schoolrenovatie', strength: 'weak', related: true, matchedTerms: ['onderwijshuisvesting'], evidence: [{ url: 'https://bouw.example/', pageType: 'home', quote: 'Onderwijshuisvesting' }] }] });
    const renderer = getDomainRenderer('companies');
    const details = { ...related, sources: [], contacts: [] } as RecordWithDetails;
    render(<MemoryRouter><dl>{renderer.renderDetailFields(details).map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>{renderer.renderDetailSections?.(details)}</MemoryRouter>);
    expect(screen.getByText('Specialisaties', { selector: 'dt' }).nextSibling).toHaveTextContent('—');
    expect(within(screen.getByLabelText('Gevonden activiteiten')).getByText('Alleen verwant begrip: onderwijshuisvesting')).toBeInTheDocument();
  });

  it('the run summary shows the batch and how many candidates wait for the next one', () => {
    render(<CompanyRunSummary run={run('r', { sourceId: 'search', batch: 2, candidatesNotResearched: 4, byStatus: {}, incompleteReasons: ['4 kandidaat-bedrijven wachten op een vervolgbatch'] })} />);
    expect(screen.getByText('Batch').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Wacht op vervolgbatch').nextSibling).toHaveTextContent('4');
  });
});
