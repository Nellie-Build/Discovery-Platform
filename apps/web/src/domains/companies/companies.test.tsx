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

const checked = '2026-09-25T10:00:00.000Z';
const activity = (kind: string, conceptId: string, label: string, strength: 'strong' | 'weak', url = 'https://www.veilig-zuid.example/diensten') => ({ kind, conceptId, label, strength, evidence: [{ url, pageType: 'services', quote: `Wij doen ${label}.` }] });
const company = (id: string, name: string, over: Record<string, unknown> = {}): DiscoveryRecord => ({
  id, project_id: 'p1', domain: 'companies', status: 'new', display_name: name, classification: { presentSignals: [], missingSignals: [] }, score: null, created_at: checked, updated_at: checked,
  domain_data: {
    identity: `${id}.example`, name, tradeNames: [], website: `https://www.${id}.example/`, domain: `${id}.example`, description: null,
    industries: [activity('industry', 'security', 'beveiliging', 'strong')], products: [activity('product', 'cctv', 'camerasystemen', 'strong')], services: [activity('service', 'installation', 'installatie', 'strong')],
    specialisations: [], customerSectors: [activity('customer_sector', 'care_institutions', 'zorginstellingen', 'strong', 'https://www.veilig-zuid.example/sectoren')], roles: [],
    locations: [{ address: 'Havenstraat 12', postcode: '3011 AB', city: 'Rotterdam', province: 'NL-ZH', country: 'NL', sourceUrl: 'https://www.veilig-zuid.example/contact' }],
    serviceAreas: [{ scope: 'province', value: 'NL-ZH', quote: 'Ons werkgebied is Zuid-Holland.', sourceUrl: 'https://www.veilig-zuid.example/over-ons' }],
    phone: '0101234567', email: 'info@veilig-zuid.example', contactUrl: 'https://www.veilig-zuid.example/contact',
    registration: { kvkNumber: null, statedKvkNumber: '12345678', statedOn: 'https://www.veilig-zuid.example/' },
    sources: [{ url: 'https://www.veilig-zuid.example/sectoren', type: 'official_website', pageType: 'sectors', title: 'Sectoren', checkedAt: checked }],
    lastCheckedAt: checked, changes: [], discovery: { via: 'web_search', query: 'camerasystemen installatie', searchProvider: 'tavily', searchSnippet: null },
    search: { criteria: 'Product: camerasystemen · Afnemer: zorginstellingen · Zuid-Holland', status: 'confirmed', checkedAt: checked, matches: [
      { kind: 'customer_sector', criterion: 'zorginstellingen', status: 'confirmed', found: 'zorginstellingen', sourceUrl: 'https://www.veilig-zuid.example/sectoren', sourceType: 'official_website', quote: 'Wij leveren camerabewaking voor zorginstellingen.', note: null, checkedAt: checked },
      { kind: 'province', criterion: 'Zuid-Holland', status: 'confirmed', found: 'Vestiging in Rotterdam', sourceUrl: 'https://www.veilig-zuid.example/contact', sourceType: 'official_website', quote: 'Havenstraat 12, 3011 AB, Rotterdam', note: null, checkedAt: checked },
    ] },
    ...over,
  },
});
const shop = company('camerashop', 'Camerashop', {
  industries: [], services: [], customerSectors: [activity('customer_sector', 'hospitals', 'ziekenhuizen', 'weak')],
  locations: [{ address: null, postcode: '3511 AB', city: 'Utrecht', province: 'NL-UT', country: 'NL', sourceUrl: 'https://camerashop.example/contact' }], serviceAreas: [],
  search: { criteria: 'x', status: 'possible', checkedAt: checked, matches: [] },
});

describe('company run form', () => {
  beforeEach(() => { vi.mocked(api.runs.startSourceRun).mockReset(); });

  it('turns a description into visible, editable criteria and sends them as a search run', async () => {
    const started = { id: 'run1' } as DiscoveryRun;
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(started);
    const onStarted = vi.fn();
    render(<CompanyRunPanel projectId="p1" onStarted={onStarted} />);
    await userEvent.click(screen.getByLabelText('Beschrijf welke bedrijven je zoekt'));
    await userEvent.paste('Ik zoek bedrijven in Zuid-Holland die camerasystemen installeren en ervaring hebben met ziekenhuizen');
    await userEvent.click(screen.getByRole('button', { name: 'Vertaal naar zoekcriteria' }));
    const recognized = within(screen.getByLabelText('Herkende zoekcriteria'));
    expect(recognized.getByText('Product: camerasystemen')).toBeInTheDocument();
    expect(recognized.getByText('Afnemerssector: ziekenhuizen')).toBeInTheDocument();
    expect(recognized.getByText('Branche: beveiliging (afgeleid)')).toBeInTheDocument();
    expect(screen.getByLabelText('Producten')).toHaveValue('camerasystemen');
    expect(screen.getByLabelText('Afnemerssector (levert aan)')).toHaveValue('ziekenhuizen');
    expect(screen.getByLabelText('Provincie')).toHaveValue('Zuid-Holland');
    // The user edits the interpretation before searching.
    await userEvent.clear(screen.getByLabelText('Branche'));
    await userEvent.click(screen.getByLabelText('Installateur'));
    await userEvent.click(screen.getByRole('button', { name: 'Zoek bedrijven' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', {
      sourceId: 'search',
      filters: { products: ['camerasystemen'], services: ['installatie'], customerSectors: ['ziekenhuizen'], roles: ['installer'], country: 'NL', provinces: ['Zuid-Holland'], description: expect.stringContaining('camerasystemen installeren') },
      runConfig: { targetRecords: 10 },
    });
    expect(onStarted).toHaveBeenCalledWith(started);
  });

  it('refuses what the server would refuse, and builds a website analysis', () => {
    expect(buildCompanyRunRequest(defaultCompanyRunFields())).toHaveProperty('error');
    expect(buildCompanyRunRequest({ ...defaultCompanyRunFields(), products: 'camerasystemen', provinces: 'Atlantis' })).toEqual({ error: 'Onbekende provincie "Atlantis".' });
    expect(buildCompanyRunRequest({ ...defaultCompanyRunFields(), products: 'x', target: '99' })).toHaveProperty('error');
    expect(buildCompanyRunRequest({ ...defaultCompanyRunFields(), mode: 'website', url: 'https://www.voorbeeld.nl' })).toEqual({ request: { sourceId: 'website', filters: { country: 'NL', url: 'https://www.voorbeeld.nl' }, runConfig: { targetRecords: 1 } } });
    expect(buildCompanyRunRequest({ ...defaultCompanyRunFields(), mode: 'website' })).toEqual({ error: 'Geef de website van het bedrijf op.' });
  });

  it('the run summary separates confirmed, possible and insufficient, and says honestly when the run was partial', () => {
    const run = { id: 'r', status: 'partial', error: null, recordsCreated: 2, stats: {
      sourceId: 'search', criteriaSummary: 'Product: camerasystemen · Zuid-Holland', queries: [{}, {}], searchResults: 12, companyCandidates: 5, companiesResearched: 4, candidatesNotResearched: 1,
      byStatus: { confirmed: 1, possible: 1, insufficient: 0 }, insufficientCount: 2, excludedResults: { directory: 3 }, sitesFailed: [{ domain: 'kapot.example', reason: 'niet bereikbaar' }],
      incompleteReasons: ['1 website(s) konden niet worden gelezen'], yield: 'confirmed_matches', recordsUpdated: 0, duplicatesUnchanged: 0,
    } } as unknown as DiscoveryRun;
    render(<CompanyRunSummary run={run} />);
    expect(screen.getByText(/Gedeeltelijk uitgevoerd: 1 website\(s\) konden niet worden gelezen/)).toBeInTheDocument();
    expect(screen.getByText('Onvoldoende bewijs (niet opgeslagen)').nextSibling).toHaveTextContent('2');
    expect(screen.getByText(/bedrijvengidsen \(3\)/)).toBeInTheDocument();
    expect(screen.getByText('kapot.example: niet bereikbaar')).toBeInTheDocument();
  });
});

describe('company records', () => {
  it('lists companies (not pages) with branch, location, activities, website, match status and last check', () => {
    render(<MemoryRouter><RecordsTable records={[company('veilig-zuid', 'Veilig Zuid B.V.'), shop]} emptyTitle="unused" /></MemoryRouter>);
    for (const header of ['Bedrijf', 'Branche', 'Vestiging', 'Producten / diensten', 'Website', 'Match', 'Laatst gecontroleerd']) expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    const row = within(screen.getByRole('row', { name: /Veilig Zuid/ }));
    expect(row.getByText('Rotterdam')).toBeInTheDocument();
    expect(row.getByText('Bevestigde match')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Camerashop/ })).getByText('Mogelijke match')).toBeInTheDocument();
  });

  it('filters by verification status, customer sector (substantiated only) and region', async () => {
    render(<MemoryRouter><RecordsTable records={[company('veilig-zuid', 'Veilig Zuid B.V.'), shop]} emptyTitle="unused" /></MemoryRouter>);
    expect(screen.getByText('2 van 2 bedrijven')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Levert aan')).queryByRole('option', { name: 'ziekenhuizen' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Levert aan'), 'zorginstellingen');
    expect(screen.getByText('1 van 2 bedrijven')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Levert aan'), '');
    await userEvent.selectOptions(screen.getByLabelText('Regio'), 'Utrecht');
    expect(screen.queryByRole('row', { name: /Veilig Zuid/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Regio'), '');
    await userEvent.selectOptions(screen.getByLabelText('Verificatiestatus'), 'confirmed');
    await waitFor(() => expect(screen.queryByRole('row', { name: /Camerashop/ })).not.toBeInTheDocument());
  });

  it('the detail page shows the profile, evidence per criterion with sources, and a stated KvK number as not verified', () => {
    const renderer = getDomainRenderer('companies');
    const record = { ...company('veilig-zuid', 'Veilig Zuid B.V.'), sources: [], contacts: [] } as RecordWithDetails;
    const fields = renderer.renderDetailFields(record);
    render(<MemoryRouter><dl>{fields.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>{renderer.renderDetailSections?.(record)}</MemoryRouter>);
    expect(screen.getByText('(vermeld op de eigen website, niet geverifieerd)')).toBeInTheDocument();
    expect(screen.getByText('Levert aan (onderbouwd)').nextSibling).toHaveTextContent('zorginstellingen');
    const evidence = within(screen.getByLabelText('Bewijs per criterium'));
    expect(evidence.getByText('Vestiging in Rotterdam')).toBeInTheDocument();
    expect(evidence.getAllByRole('link', { name: 'Eigen website' })[0]).toHaveAttribute('href', 'https://www.veilig-zuid.example/sectoren');
    expect(within(screen.getByLabelText('Gevonden activiteiten')).getAllByText('Specifiek onderbouwd').length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText('Bronnen')).getByText(/Een zoekresultaat alleen geldt niet als bewijs/)).toBeInTheDocument();
  });
});
