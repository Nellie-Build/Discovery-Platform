import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, type DiscoveryRun } from '@discovery-platform/client';
import { TenderRunPanel, TenderRunSummary, buildTenderRunRequest, defaultTenderRunFields, type TenderRunFields } from './run-panel';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

const run = (overrides: Partial<DiscoveryRun> = {}): DiscoveryRun => ({
  id: 'r1', project_id: 'p1', status: 'succeeded', started_at: null, completed_at: null, stats: {}, error: null, created_at: '2026-09-21T10:00:00.000Z', ...overrides,
});
const fill = async (label: string, value: string) => {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
};
const mode = (name: string) => userEvent.click(screen.getByRole('radio', { name }));

const defaults = defaultTenderRunFields(new Date('2026-09-21T12:00:00'));
const direct = (over: Partial<TenderRunFields> = {}): TenderRunFields => ({ ...defaults, mode: 'direct', source: 'tenderned', publishedFrom: '2026-09-19', publishedTo: '2026-09-21', ...over });

describe('buildTenderRunRequest: direct source', () => {
  it('builds the sourceId request with dates, prefixes and the wanted number; empty filters are left out', () => {
    expect(buildTenderRunRequest(direct())).toEqual({ request: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' }, runConfig: { targetRecords: 20 } } });
    expect(buildTenderRunRequest(direct({ cpvPrefixes: '45, 72000000', nutsPrefixes: 'nl33 NL41', target: '50' }))).toEqual({
      request: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', cpvPrefixes: ['45', '72000000'], nutsPrefixes: ['NL33', 'NL41'] }, runConfig: { targetRecords: 50 } },
    });
  });
  it('TED is the same request with sourceId ted', () => {
    expect(buildTenderRunRequest(direct({ source: 'ted' }))).toEqual({ request: { sourceId: 'ted', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' }, runConfig: { targetRecords: 20 } } });
  });
  it('a website is the website source with its URL (a bare domain gets https) and no publication dates', () => {
    expect(buildTenderRunRequest(direct({ source: 'website', url: 'www.voorbeeld.nl/aanbestedingen', cpvPrefixes: '45' }))).toEqual({
      request: { sourceId: 'website', filters: { url: 'https://www.voorbeeld.nl/aanbestedingen', cpvPrefixes: ['45'] }, runConfig: { targetRecords: 20 } },
    });
    expect(buildTenderRunRequest(direct({ source: 'website', url: '' }))).toEqual({ error: 'Geef de URL van een website op.' });
    expect(buildTenderRunRequest(direct({ source: 'website', url: 'ftp://voorbeeld.nl' }))).toHaveProperty('error');
    expect(buildTenderRunRequest(direct({ source: 'website', url: 'geen url' }))).toHaveProperty('error');
  });
  it('defaults to the last 30 days, in search mode', () => {
    expect(defaults).toMatchObject({ mode: 'search', publishedFrom: '2026-08-23', publishedTo: '2026-09-21', target: '20', country: 'NL' });
  });
  it('refuses what the server would refuse, with a message the user can act on', () => {
    expect(buildTenderRunRequest(direct({ publishedFrom: '2026-09-22' }))).toEqual({ error: 'De einddatum ligt voor de begindatum.' });
    expect(buildTenderRunRequest(direct({ publishedFrom: '2026-01-01' }))).toEqual({ error: 'De periode mag maximaal 90 dagen beslaan.' });
    expect(buildTenderRunRequest(direct({ publishedFrom: '2026-09-08' }))).toHaveProperty('request');
    expect(buildTenderRunRequest(direct({ cpvPrefixes: '4' }))).toHaveProperty('error');
    expect(buildTenderRunRequest(direct({ cpvPrefixes: 'abc' }))).toHaveProperty('error');
    expect(buildTenderRunRequest(direct({ nutsPrefixes: '3N' }))).toHaveProperty('error');
    for (const target of ['0', '201', '2.5', '', 'x']) expect(buildTenderRunRequest(direct({ target }))).toHaveProperty('error');
  });
});

describe('buildTenderRunRequest: search and automatic', () => {
  const search = (over: Partial<TenderRunFields> = {}): TenderRunFields => ({ ...defaults, mode: 'search', branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', ...over });
  it('search keeps branch and keywords as separate fields, with country, region and CPV, and a publication period', () => {
    expect(buildTenderRunRequest(search({ cpvPrefixes: '45' }))).toEqual({
      request: { sourceId: 'search', filters: { publishedFrom: defaults.publishedFrom, publishedTo: defaults.publishedTo, branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'NL', cpvPrefixes: ['45'] }, runConfig: { targetRecords: 20 } },
    });
  });
  it('search needs a branch or keywords; either one is enough', () => {
    expect(buildTenderRunRequest(search({ branch: '', keywords: '' }))).toEqual({ error: 'Geef een branche of zoektermen op om naar aanbestedingen te zoeken.' });
    expect(buildTenderRunRequest(search({ branch: '  ', keywords: 'onderhoud scholen', region: '' }))).toEqual({
      request: { sourceId: 'search', filters: { publishedFrom: defaults.publishedFrom, publishedTo: defaults.publishedTo, keywords: 'onderhoud scholen', country: 'NL' }, runConfig: { targetRecords: 20 } },
    });
  });
  it('automatic sends the text fields and the publication period for the API sources; the text is optional', () => {
    expect(buildTenderRunRequest(search({ mode: 'auto', publishedFrom: '2026-09-19', publishedTo: '2026-09-21', nutsPrefixes: 'NL33' }))).toEqual({
      request: { sourceId: 'auto', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', nutsPrefixes: ['NL33'], branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'NL' }, runConfig: { targetRecords: 20 } },
    });
    expect(buildTenderRunRequest(search({ mode: 'auto', branch: '', keywords: '', region: '' }))).toHaveProperty('request');
    expect(buildTenderRunRequest(search({ mode: 'auto', publishedFrom: '2026-01-01' }))).toEqual({ error: 'De periode mag maximaal 90 dagen beslaan.' });
  });
});

describe('TenderRunPanel', () => {
  beforeEach(() => { vi.mocked(api.runs.startSourceRun).mockReset(); });

  it('opens on "Zoeken": branch, keywords, country, region, CPV and the wanted number — no dates, no source choice', () => {
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Zoeken' })).toBeChecked();
    for (const label of ['Branche', 'Zoektermen', 'Land', 'Regio', 'CPV-prefix', 'Gewenst aantal resultaten']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    for (const label of ['Website-URL']) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'TenderNed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoek aanbestedingen' })).toBeInTheDocument();
  });

  it('starts a search run with branch and keywords as separate filters', async () => {
    const started = run({ id: 'run-1' });
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(started);
    const onStarted = vi.fn();
    render(<TenderRunPanel projectId="p1" onStarted={onStarted} />);
    await fill('Branche', 'Bouw');
    await fill('Zoektermen', 'renovatie schoolgebouwen');
    await fill('Regio', 'Zuid-Holland');
    await userEvent.selectOptions(screen.getByLabelText('Land'), 'BE');
    await fill('CPV-prefix', '45');
    await userEvent.click(screen.getByRole('button', { name: 'Zoek aanbestedingen' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', {
      sourceId: 'search', filters: { publishedFrom: expect.any(String), publishedTo: expect.any(String), branch: 'Bouw', keywords: 'renovatie schoolgebouwen', region: 'Zuid-Holland', country: 'BE', cpvPrefixes: ['45'] }, runConfig: { targetRecords: 20 },
    });
    expect(onStarted).toHaveBeenCalledWith(started);
  });

  it('"Directe bron" offers TenderNed, TED and Website-URL; the fields follow the choice', async () => {
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(run());
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await mode('Directe bron');
    for (const name of ['TenderNed', 'TED', 'Website-URL']) expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    for (const label of ['Gepubliceerd vanaf', 'Gepubliceerd tot en met', 'CPV-prefix', 'NUTS-prefix', 'Gewenst aantal resultaten']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByLabelText('Branche')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Website-URL' }));
    expect(screen.getByLabelText('Website-URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Gepubliceerd vanaf')).not.toBeInTheDocument();
    await fill('Website-URL', 'https://www.voorbeeld.nl/aanbestedingen');
    await userEvent.click(screen.getByRole('button', { name: 'Crawl website' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', { sourceId: 'website', filters: { url: 'https://www.voorbeeld.nl/aanbestedingen' }, runConfig: { targetRecords: 20 } });
  });

  it('starts a TenderNed run from "Directe bron" with dates, prefixes and count', async () => {
    const started = run({ id: 'run-9', recordsCreated: 3 });
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(started);
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await mode('Directe bron');
    await fill('Gepubliceerd vanaf', '2026-09-19');
    await fill('Gepubliceerd tot en met', '2026-09-21');
    await fill('CPV-prefix', '45');
    await fill('NUTS-prefix', 'nl33');
    await fill('Gewenst aantal resultaten', '30');
    await userEvent.click(screen.getByRole('button', { name: 'Start TenderNed-run' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', {
      sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', cpvPrefixes: ['45'], nutsPrefixes: ['NL33'] }, runConfig: { targetRecords: 30 },
    });
  });

  it('"Automatisch" combines the text fields and the period and starts sourceId "auto"', async () => {
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(run());
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await mode('Automatisch');
    for (const label of ['Branche', 'Zoektermen', 'Gepubliceerd vanaf', 'NUTS-prefix']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    await fill('Branche', 'ICT');
    await fill('Zoektermen', 'security');
    await fill('Gepubliceerd vanaf', '2026-09-19');
    await fill('Gepubliceerd tot en met', '2026-09-21');
    await userEvent.click(screen.getByRole('button', { name: 'Start automatische run' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', {
      sourceId: 'auto', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', branch: 'ICT', keywords: 'security', country: 'NL' }, runConfig: { targetRecords: 20 },
    });
  });

  it('shows a validation message without calling the API', async () => {
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoek aanbestedingen' }));
    expect(screen.getByText('Geef een branche of zoektermen op om naar aanbestedingen te zoeken.')).toBeInTheDocument();
    await fill('Branche', 'Bouw');
    await fill('CPV-prefix', 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Zoek aanbestedingen' }));
    expect(screen.getByText(/CPV-prefix bestaat uit 2 tot 8 cijfers/)).toBeInTheDocument();
    expect(api.runs.startSourceRun).not.toHaveBeenCalled();
  });

  it('shows the message of the server when the API refuses (for instance a disabled module)', async () => {
    vi.mocked(api.runs.startSourceRun).mockRejectedValue(new ApiError(403, 'module_disabled', 'The "Aanbestedingen" module is currently disabled.'));
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await fill('Branche', 'Bouw');
    await userEvent.click(screen.getByRole('button', { name: 'Zoek aanbestedingen' }));
    expect(await screen.findByText('The "Aanbestedingen" module is currently disabled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoek aanbestedingen' })).toBeEnabled();
  });
});

describe('TenderRunSummary', () => {
  it('reports created, updated and unchanged apart, the period and why the run stopped', () => {
    render(<TenderRunSummary run={run({ recordsCreated: 5, stats: { publishedFrom: '2026-09-20', publishedTo: '2026-09-21', publicationsFetched: 40, tendersFound: 38, recordsUpdated: 2, duplicatesUnchanged: 31, filteredOut: 4, stopReason: 'target_reached' } })} />);
    const value = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;
    expect(value('Periode')).toBe('2026-09-20 t/m 2026-09-21');
    expect(value('Publicaties opgehaald')).toBe('40');
    expect(value('Aanbestedingen')).toBe('38');
    expect(value('Nieuw')).toBe('5');
    expect(value('Bijgewerkt')).toBe('2');
    expect(value('Ongewijzigd')).toBe('31');
    expect(value('Weggefilterd (CPV/NUTS)')).toBe('4');
    expect(value('Resultaat')).toBe('Gewenst aantal bereikt');
  });
  it('a website or search run reports pages, concrete tenders and why pages were rejected', () => {
    render(<TenderRunSummary run={run({ recordsCreated: 3, stats: {
      sourceId: 'search', queries: [{}, {}, {}], searchCandidates: 14, overviewCrawls: 2, pagesVisited: 21, concreteTenders: 3, overviewPages: 2, generalInformationPages: 4, rejectedPages: 11,
      rejectionReasons: { overview_page: 2, general_procurement_information: 4, insufficient_evidence: 5 }, duplicatesUnchanged: 0, stopReason: 'no_more_candidates', sourceRoles: { official_organization_site: 1, aggregator: 2, unknown_web_source: 0 },
    } })} />);
    const value = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;
    expect(screen.getByText('Zoek-run')).toBeInTheDocument();
    expect(value('Zoekopdrachten')).toBe('3');
    expect(value('Kandidaat-pagina’s')).toBe('14');
    expect(value('Concrete aanbestedingen')).toBe('3');
    expect(value('Algemene inkoopinformatie')).toBe('4');
    expect(value('Afgewezen pagina’s')).toBe('11');
    expect(value('Officiële sites')).toBe('1');
    expect(value('Aggregators')).toBe('2');
    expect(value('Onbekende webbronnen')).toBe('0');
    expect(screen.getByText(/Overzichtspagina \(2\) · Algemene inkoopinformatie \(4\) · Te weinig bewijs \(5\)/)).toBeInTheDocument();
    expect(screen.queryByText('Periode', { selector: 'dt' })).not.toBeInTheDocument();
  });
  it('an automatic run lists every source with its own outcome', () => {
    render(<TenderRunSummary run={run({ status: 'partial', recordsCreated: 4, stats: { sourceId: 'auto', filteredByKeywords: 7, sources: [
      { sourceId: 'tenderned', status: 'ok', publications: 40 }, { sourceId: 'ted', status: 'failed', error: 'timeout: TED did not answer' }, { sourceId: 'search', status: 'skipped', reason: 'Er is geen zoekprovider geconfigureerd.' },
    ] } })} />);
    const list = screen.getByRole('list', { name: 'Bronnen' });
    expect(list).toHaveTextContent('TenderNed40 resultaten');
    expect(list).toHaveTextContent('TEDMislukt: timeout: TED did not answer');
    expect(list).toHaveTextContent('Zoeken op het webOvergeslagen: Er is geen zoekprovider geconfigureerd.');
    expect(screen.getByText('Weggefilterd (zoektermen)', { selector: 'dt' }).nextElementSibling).toHaveTextContent('7');
  });
  it('shows the error of a failed run', () => {
    render(<TenderRunSummary run={run({ status: 'failed', error: 'timeout: TenderNed did not answer within 15000 ms.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('timeout: TenderNed did not answer');
  });
});
