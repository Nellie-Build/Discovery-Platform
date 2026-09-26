import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryJob, DiscoveryRecord, DiscoveryRun, RecordWithDetails } from '@discovery-platform/client';
import { RecordsTable } from '../../components/records-table';
import { getDomainRenderer } from '../registry';
import { CompanyRunPanel, buildCompanyRunRequest, defaultCompanyRunFields, liveWarnings } from './run-panel';
import { buildJobLimits, defaultJobLimits } from './job-panel';
import '../index';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

/** Companies 2.0 in the web app: AND/OR, excluded types, extended processing with progress and controls, filters, explanation, export. */
const checked = '2026-09-26T10:00:00.000Z';
const company = (id: string, over: Record<string, unknown> = {}): DiscoveryRecord => ({
  id, project_id: 'p1', domain: 'companies', status: 'new', display_name: id, classification: {}, score: null, created_at: checked, updated_at: checked,
  domain_data: {
    identity: `${id}.example`, domain: `${id}.example`, website: `https://${id}.example/`, tradeNames: [], industries: [], services: [], specialisations: [], customerSectors: [], roles: [],
    products: [{ kind: 'product', conceptId: 'cctv', label: 'camerasystemen', strength: 'strong', evidence: [{ url: `https://${id}.example/diensten`, quote: 'Wij installeren camerasystemen.' }], actions: [{ action: 'installs', url: `https://${id}.example/diensten`, quote: 'Wij installeren camerasystemen.' }] }],
    businessTypes: [], locations: [], serviceAreas: [], sources: [], changes: [], lastCheckedAt: checked,
    registration: { kvkNumber: null, statedKvkNumber: null, statedOn: null },
    search: { criteria: 'x', status: 'possible', checkedAt: checked, matches: [
      { kind: 'product', criterion: 'camerasystemen', status: 'confirmed', found: 'camerasystemen', sourceUrl: null, sourceType: 'official_website', quote: null, note: null, checkedAt: checked },
      { kind: 'province', criterion: 'Zuid-Holland', status: 'insufficient', found: null, sourceUrl: null, sourceType: null, quote: null, note: null, checkedAt: checked },
    ] },
    ...over,
  },
} as DiscoveryRecord);
const job = (over: Partial<DiscoveryJob> = {}): DiscoveryJob => ({
  id: 'job-1', projectId: 'p1', status: 'running', message: null,
  limits: { maxCandidates: 20, batchSize: 5, pagesPerCompany: 5, maxSearchQueries: 6, maxBatches: 7 },
  usage: { batches: 1, batchesFailed: 0, candidatesResearched: 5, searchQueries: 6, pagesVisited: 20, recordsCreated: 3, recordsUpdated: 0, candidatesRemaining: 12 },
  progress: { candidatesResearched: 5, maxCandidates: 20, candidatesRemaining: 12 },
  batches: [{ runId: 'run-1', status: 'succeeded', batch: 1, error: null, companiesResearched: 5, recordsCreated: 3, recordsUpdated: 0, searchQueries: 6, createdAt: checked, completedAt: checked }],
  createdAt: checked, updatedAt: checked, finishedAt: null, ...over,
});

describe('companies 2.0: criteria in the form', () => {
  it('OR is the default and not sent; AND is sent only for a list with two or more values; excluded types are sent', () => {
    const base = { ...defaultCompanyRunFields(), products: 'camerasystemen, toegangscontrolesystemen' };
    const or = buildCompanyRunRequest(base) as { request: { filters: Record<string, unknown> } };
    expect(or.request.filters).not.toHaveProperty('logic');
    const and = buildCompanyRunRequest({ ...base, allOf: ['products', 'services'], excludedBusinessTypes: ['consumer_webshop'] }) as { request: { filters: Record<string, unknown> } };
    expect(and.request.filters.logic).toEqual({ products: 'all' });
    expect(and.request.filters.excludedBusinessTypes).toEqual(['consumer_webshop']);
  });

  it('shows how a description was read, offers the AND/OR choice, and warns about contradictions', async () => {
    render(<CompanyRunPanel projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByLabelText('Beschrijf welke bedrijven je zoekt'));
    await userEvent.paste('installateurs van camerabewaking en toegangscontrole, geen webwinkels');
    await userEvent.click(screen.getByRole('button', { name: 'Vertaal naar zoekcriteria' }));
    expect(screen.getByLabelText('Controleer je zoekcriteria')).toHaveTextContent('één van beide volstaat');
    expect(screen.getByLabelText('Combinatie Producten')).toHaveValue('any');
    expect(screen.getByLabelText('Uitsluiten: Consumentenwebwinkel')).toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText('Combinatie Producten'), 'all');
    expect(screen.getByLabelText('Combinatie Producten')).toHaveValue('all');
    // Asking for web shops and excluding them at the same time is flagged.
    await userEvent.click(within(screen.getByRole('group', { name: 'Type bedrijf' })).getByLabelText('Consumentenwebwinkel'));
    expect(screen.getByLabelText('Controleer je zoekcriteria').textContent).toMatch(/Consumentenwebwinkel/i);
    expect(liveWarnings({ ...defaultCompanyRunFields(), products: 'camerasystemen', provinces: 'Zuid-Holland', places: 'Arnhem' }).join(' ')).toMatch(/Arnhem/);
  });
});

describe('companies 2.0: extended processing', () => {
  beforeEach(() => {
    for (const fn of [api.jobs.start, api.jobs.listByProject, api.jobs.get, api.jobs.pause, api.jobs.stop, api.runs.get, api.runs.startSourceRun, api.runs.listByProject]) vi.mocked(fn).mockReset();
    vi.mocked(api.runs.listByProject).mockResolvedValue([]);
  });

  it('limits are required and bounded', () => {
    expect(buildJobLimits(defaultJobLimits())).toEqual({ limits: { maxCandidates: 30, batchSize: 5, pagesPerCompany: 5, maxSearchQueries: 6 } });
    expect(buildJobLimits({ ...defaultJobLimits(), maxCandidates: '500' })).toHaveProperty('error');
    expect(buildJobLimits({ ...defaultJobLimits(), pagesPerCompany: '0' })).toHaveProperty('error');
  });

  it('starts a job with the user\'s limits instead of a run, then shows its progress and lets the user pause or stop it', async () => {
    vi.mocked(api.jobs.listByProject).mockResolvedValueOnce([]).mockResolvedValue([job()]);
    vi.mocked(api.jobs.get).mockResolvedValue(job());
    vi.mocked(api.jobs.start).mockResolvedValue(job({ status: 'queued', batches: [] }));
    vi.mocked(api.jobs.pause).mockResolvedValue(job({ status: 'paused', updatedAt: '2026-09-26T10:05:00.000Z' }));
    const onStarted = vi.fn();
    render(<CompanyRunPanel projectId="p1" onStarted={onStarted} />);
    await userEvent.type(screen.getByLabelText('Producten'), 'camerasystemen');
    await userEvent.click(screen.getByLabelText('Uitgebreide verwerking op de achtergrond'));
    await userEvent.clear(screen.getByLabelText('Maximaal aantal kandidaat-bedrijven (totaal)'));
    await userEvent.type(screen.getByLabelText('Maximaal aantal kandidaat-bedrijven (totaal)'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Start uitgebreide verwerking' }));
    expect(api.jobs.start).toHaveBeenCalledWith('p1', expect.objectContaining({ sourceId: 'search', filters: expect.objectContaining({ products: ['camerasystemen'] }) }), { maxCandidates: 20, batchSize: 5, pagesPerCompany: 5, maxSearchQueries: 6 });
    expect(api.runs.startSourceRun).not.toHaveBeenCalled();
    const progress = await screen.findByLabelText('Uitgebreide verwerking');
    expect(progress).toHaveTextContent('5 van maximaal 20 kandidaat-bedrijven onderzocht');
    expect(progress).toHaveTextContent('12 wachten nog');
    await userEvent.click(within(progress).getByRole('button', { name: 'Pauzeren' }));
    expect(api.jobs.pause).toHaveBeenCalledWith('job-1');
    await waitFor(() => expect(within(screen.getByLabelText('Uitgebreide verwerking')).getByRole('button', { name: 'Hervatten' })).toBeInTheDocument());
  });

  it('a batch that finishes while the page is open is handed to the page, so its results show', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.jobs.listByProject).mockResolvedValue([job()]);
      const second = { runId: 'run-2', status: 'succeeded' as const, batch: 2, error: null, companiesResearched: 5, recordsCreated: 2, recordsUpdated: 0, searchQueries: 0, createdAt: checked, completedAt: checked };
      vi.mocked(api.jobs.get).mockResolvedValueOnce(job()).mockResolvedValue(job({ batches: [second, ...job().batches], updatedAt: '2026-09-26T10:10:00.000Z' }));
      const run2 = { id: 'run-2', project_id: 'p1', status: 'succeeded', stats: {}, created_at: checked } as unknown as DiscoveryRun;
      vi.mocked(api.runs.get).mockResolvedValue(run2);
      const onStarted = vi.fn();
      render(<CompanyRunPanel projectId="p1" onStarted={onStarted} />);
      await screen.findByLabelText('Uitgebreide verwerking');
      await vi.advanceTimersByTimeAsync(9000);
      await waitFor(() => expect(onStarted).toHaveBeenCalledWith(run2));
      expect(api.runs.get).not.toHaveBeenCalledWith('run-1');
    } finally { vi.useRealTimers(); }
  });

  it('the manual next-batch button is not offered for a batch of a background job', async () => {
    vi.mocked(api.jobs.listByProject).mockResolvedValue([]);
    vi.mocked(api.runs.listByProject).mockResolvedValue([{ id: 'r1', project_id: 'p1', status: 'partial', stats: { jobId: 'job-1', continuation: { cursor: 'x', remaining: 5 } }, created_at: checked } as unknown as DiscoveryRun]);
    render(<CompanyRunPanel projectId="p1" onStarted={vi.fn()} />);
    await waitFor(() => expect(api.runs.listByProject).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Volgende batch/ })).not.toBeInTheDocument();
  });
});

describe('companies 2.0: results', () => {
  beforeEach(() => { vi.mocked(api.records.exportCsv).mockReset(); });

  it('filters establishment and service area apart; a postal address is not an establishment', async () => {
    const gelderland = company('camfab', {
      locations: [{ address: 'Frankeneng 20', postcode: '6716 AA', city: 'Ede', municipality: 'Ede', province: 'NL-GE', country: 'NL', addressType: 'visiting', sourceUrl: 'https://camfab.example/contact' }],
      serviceAreas: [{ scope: 'national', value: 'NL', quote: 'Wij leveren in heel Nederland.', sourceUrl: 'https://camfab.example/' }],
    });
    const postbus = company('haagse', {
      locations: [{ address: 'Postbus 1234', postcode: '2501 CA', city: 'Den Haag', municipality: 'Den Haag', province: 'NL-ZH', country: 'NL', addressType: 'postal', sourceUrl: 'https://haagse.example/contact' }],
    });
    render(<MemoryRouter><RecordsTable records={[gelderland, postbus]} emptyTitle="unused" /></MemoryRouter>);
    expect(within(screen.getByLabelText('Vestiging')).queryByRole('option', { name: 'Den Haag' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Werkgebied'), 'Heel Nederland');
    expect(screen.getByText('1 van 2 bedrijven')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Werkgebied'), '');
    await userEvent.selectOptions(screen.getByLabelText('Vestiging'), 'Gelderland');
    expect(screen.queryByRole('row', { name: /haagse/ })).not.toBeInTheDocument();
  });

  it('exports the filtered companies or all of them, as the user chooses', async () => {
    vi.mocked(api.records.exportCsv).mockResolvedValue({ blob: new Blob(['x']), filename: 'bedrijven.csv' });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const confirmed = company('veilig', { search: { criteria: 'x', status: 'confirmed', checkedAt: checked, matches: [] } });
    render(<MemoryRouter><RecordsTable records={[confirmed, company('shop')]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Exporteer gefilterde/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Exporteer alle bedrijven (2)' }));
    expect(api.records.exportCsv).toHaveBeenLastCalledWith('p1', undefined);
    await userEvent.selectOptions(screen.getByLabelText('Verificatiestatus'), 'confirmed');
    await userEvent.click(screen.getByRole('button', { name: 'Exporteer gefilterde bedrijven (1)' }));
    expect(api.records.exportCsv).toHaveBeenLastCalledWith('p1', ['veilig']);
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('the detail page explains the fit in words, and shows what the company does with a product', () => {
    const record = { ...company('veilig'), sources: [], contacts: [] } as unknown as RecordWithDetails;
    render(<MemoryRouter>{getDomainRenderer('companies').renderDetailSections!(record)}</MemoryRouter>);
    expect(screen.getByLabelText('Uitleg')).toHaveTextContent('Bevestigd: levert camerasystemen. Onbekend: werkgebied Zuid-Holland.');
    expect(screen.getByLabelText('Uitleg').textContent).not.toMatch(/%|score/i);
    expect(within(screen.getByLabelText('Gevonden activiteiten')).getByRole('link', { name: 'installeert' })).toHaveAttribute('href', 'https://veilig.example/diensten');
  });
});
