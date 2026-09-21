import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, type DiscoveryRun } from '@discovery-platform/client';
import { TenderRunPanel, TenderRunSummary, buildTenderRunRequest, defaultTenderRunFields } from './run-panel';

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

describe('buildTenderRunRequest', () => {
  const base = { ...defaultTenderRunFields(new Date('2026-09-21T12:00:00')), publishedFrom: '2026-09-19', publishedTo: '2026-09-21' };
  it('builds the sourceId request with dates, prefixes and the wanted number; empty filters are left out', () => {
    expect(buildTenderRunRequest(base)).toEqual({ request: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21' }, runConfig: { targetRecords: 20 } } });
    expect(buildTenderRunRequest({ ...base, cpvPrefixes: '45, 72000000', nutsPrefixes: 'nl33 NL41', target: '50' })).toEqual({
      request: { sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', cpvPrefixes: ['45', '72000000'], nutsPrefixes: ['NL33', 'NL41'] }, runConfig: { targetRecords: 50 } },
    });
  });
  it('defaults to yesterday and today', () => {
    expect(defaultTenderRunFields(new Date('2026-09-21T12:00:00'))).toMatchObject({ publishedFrom: '2026-09-20', publishedTo: '2026-09-21', target: '20' });
  });
  it('refuses what the server would refuse, with a message the user can act on', () => {
    expect(buildTenderRunRequest({ ...base, publishedFrom: '2026-09-22' })).toEqual({ error: 'De einddatum ligt voor de begindatum.' });
    expect(buildTenderRunRequest({ ...base, publishedFrom: '2026-08-01' })).toEqual({ error: 'De periode mag maximaal 14 dagen beslaan.' });
    expect(buildTenderRunRequest({ ...base, publishedFrom: '2026-09-08' })).toHaveProperty('request');
    expect(buildTenderRunRequest({ ...base, cpvPrefixes: '4' })).toHaveProperty('error');
    expect(buildTenderRunRequest({ ...base, cpvPrefixes: 'abc' })).toHaveProperty('error');
    expect(buildTenderRunRequest({ ...base, nutsPrefixes: '3N' })).toHaveProperty('error');
    for (const target of ['0', '201', '2.5', '', 'x']) expect(buildTenderRunRequest({ ...base, target })).toHaveProperty('error');
  });
});

describe('TenderRunPanel', () => {
  beforeEach(() => { vi.mocked(api.runs.startSourceRun).mockReset(); });

  it('has the date, CPV, NUTS and count fields, and starts a source run with sourceId tenderned', async () => {
    const started = run({ id: 'run-9', recordsCreated: 3 });
    vi.mocked(api.runs.startSourceRun).mockResolvedValue(started);
    const onStarted = vi.fn();
    render(<TenderRunPanel projectId="p1" onStarted={onStarted} />);
    await fill('Gepubliceerd vanaf', '2026-09-19');
    await fill('Gepubliceerd tot en met', '2026-09-21');
    await fill('CPV-prefix', '45');
    await fill('NUTS-prefix', 'nl33');
    await fill('Gewenst aantal resultaten', '30');
    await userEvent.click(screen.getByRole('button', { name: 'Start TenderNed-run' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledWith('p1', {
      sourceId: 'tenderned', filters: { publishedFrom: '2026-09-19', publishedTo: '2026-09-21', cpvPrefixes: ['45'], nutsPrefixes: ['NL33'] }, runConfig: { targetRecords: 30 },
    });
    expect(onStarted).toHaveBeenCalledWith(started);
  });

  it('shows a validation message without calling the API', async () => {
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await fill('CPV-prefix', 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Start TenderNed-run' }));
    expect(screen.getByText(/CPV-prefix bestaat uit 2 tot 8 cijfers/)).toBeInTheDocument();
    expect(api.runs.startSourceRun).not.toHaveBeenCalled();
  });

  it('shows the message of the server when the API refuses (for instance a disabled module)', async () => {
    vi.mocked(api.runs.startSourceRun).mockRejectedValue(new ApiError(403, 'module_disabled', 'The "Aanbestedingen" module is currently disabled.'));
    render(<TenderRunPanel projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start TenderNed-run' }));
    expect(await screen.findByText('The "Aanbestedingen" module is currently disabled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start TenderNed-run' })).toBeEnabled();
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
  it('shows the error of a failed run', () => {
    render(<TenderRunSummary run={run({ status: 'failed', error: 'timeout: TenderNed did not answer within 15000 ms.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('timeout: TenderNed did not answer');
  });
});
