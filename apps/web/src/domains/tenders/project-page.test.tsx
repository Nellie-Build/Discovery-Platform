import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DiscoveryRecord, DiscoveryRun, Project } from '@discovery-platform/client';
import { ProjectDetailPage } from '../../pages/project-detail';
import '../index';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

const now = '2026-09-21T10:00:00.000Z';
const project: Project = { id: 'p1', workspace_id: 'w1', name: 'Tenders NL', domain: 'tenders', status: 'active', config: {}, created_at: now, updated_at: now, deleted_at: null, deleted_by: null };
const record: DiscoveryRecord = {
  id: 't1', project_id: 'p1', domain: 'tenders', status: 'new', display_name: 'Bouw van een brug', classification: {}, score: 90, created_at: now, updated_at: now,
  domain_data: { sourceSystem: 'tenderned', tenderIdentity: '1', title: 'Bouw van een brug', contractingAuthority: 'Provincie X', submissionDeadline: '2026-11-02T08:00:00', procedureType: 'Openbaar', noticeTypeLabel: 'Aankondiging opdracht', publications: [] },
};
const startedRun: DiscoveryRun = {
  id: 'r1', project_id: 'p1', status: 'succeeded', started_at: now, completed_at: now, error: null, created_at: now, recordsCreated: 1,
  stats: { publishedFrom: '2026-09-20', publishedTo: '2026-09-21', publicationsFetched: 12, tendersFound: 11, recordsUpdated: 0, duplicatesUnchanged: 0, stopReason: 'no_more_candidates' },
};

function renderPage() {
  return render(<MemoryRouter initialEntries={['/projects/p1']}><Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes></MemoryRouter>);
}

describe('project page of a tender project', () => {
  beforeEach(() => {
    vi.mocked(api.projects.get).mockReset().mockResolvedValue(project);
    vi.mocked(api.records.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.get).mockReset().mockResolvedValue(startedRun);
    vi.mocked(api.runs.start).mockReset();
    vi.mocked(api.runs.startBranchSearch).mockReset();
    vi.mocked(api.runs.startSourceRun).mockReset().mockResolvedValue(startedRun);
  });

  it('offers the three ways to look for tenders (search, direct source, automatic) instead of the website/branch form', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Zoek aanbestedingen' })).toBeInTheDocument();
    for (const name of ['Zoeken', 'Directe bron', 'Automatisch']) expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    for (const label of ['Branche', 'Zoektermen', 'Land', 'Regio', 'CPV-prefix', 'Gewenst aantal resultaten']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Directe bron' }));
    expect(await screen.findByRole('button', { name: 'Start TenderNed-run' })).toBeInTheDocument();
    for (const label of ['Gepubliceerd vanaf', 'Gepubliceerd tot en met', 'CPV-prefix', 'NUTS-prefix', 'Gewenst aantal resultaten']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByLabelText('Website URL')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Branche' })).not.toBeInTheDocument();
    expect(screen.getByText('Tenders')).toBeInTheDocument();
  });

  it('starting the run calls startSourceRun with sourceId "tenderned" and shows the tender run summary, never a website/branch call', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('radio', { name: 'Directe bron' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start TenderNed-run' }));
    expect(api.runs.startSourceRun).toHaveBeenCalledTimes(1);
    const [projectId, input] = vi.mocked(api.runs.startSourceRun).mock.calls[0];
    expect(projectId).toBe('p1');
    expect(input.sourceId).toBe('tenderned');
    expect(input.runConfig).toEqual({ targetRecords: 20 });
    expect(api.runs.start).not.toHaveBeenCalled();
    expect(api.runs.startBranchSearch).not.toHaveBeenCalled();
    const summary = await screen.findByLabelText('Run-resultaat');
    expect(summary).toHaveTextContent('Publicaties opgehaald');
    expect(summary).toHaveTextContent('Alles in de bron verwerkt');
  });

  it('lists the project\'s tenders with the tender columns', async () => {
    vi.mocked(api.records.listByProject).mockResolvedValue([record]);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Alle resultaten' }));
    expect(await screen.findByRole('columnheader', { name: 'Aanbestedende dienst' })).toBeInTheDocument();
    expect(screen.getByText('Provincie X')).toBeInTheDocument();
    expect(screen.getByText('02-11-2026 08:00')).toBeInTheDocument();
  });
});
