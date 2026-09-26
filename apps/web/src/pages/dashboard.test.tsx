import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryRecord, DiscoveryRun, Project } from '@discovery-platform/client';
import { DashboardPage } from './dashboard';
import { dashboardRecordGroups, loadDashboard } from '../lib/dashboard-data';
import '../domains';

vi.mock('../lib/api');
const workspace = vi.hoisted(() => ({
  current: { id: 'w1', name: 'Test workspace' } as { id: string; name: string } | null,
  loading: false,
  error: null,
}));
vi.mock('../lib/workspace-context', () => ({ useWorkspace: () => workspace }));
import { api } from '../lib/api';
const now = new Date().toISOString();
const project = (id = 'p1', domain = 'tenders'): Project => ({
  id,
  workspace_id: 'w1',
  name: `Project ${id}`,
  domain,
  status: 'active',
  config: {},
  created_at: now,
  updated_at: now,
  deleted_at: null,
  deleted_by: null,
});
const record = (id: string, source: string, publication: string, number?: string): DiscoveryRecord => ({
  id,
  project_id: 'p1',
  domain: 'tenders',
  display_name: `Video ${publication}`,
  status: 'new',
  score: 90,
  classification: {},
  created_at: now,
  updated_at: now,
  domain_data: {
    sourceSystem: source,
    tenderIdentity: id,
    publicationId: publication,
    title: `Video ${publication}`,
    sourceUrl: `https://example.test/${id}`,
    submissionDeadline: source === 'ted' ? null : '2026-10-22T23:59:00',
    publications: [{ publicationId: publication, tedPublicationNumber: number }],
    cpvCodes: [],
    nutsCodes: [],
  },
});
const six = ['643394-2026', '654717-2026', '655158-2026'].flatMap((number, index) => [
  record(`tn${index}`, 'tenderned', `44095${index}`, number),
  record(`ted${index}`, 'ted', number),
]);
const run: DiscoveryRun = {
  id: 'r1',
  project_id: 'p1',
  status: 'partial',
  started_at: now,
  completed_at: now,
  created_at: now,
  error: null,
  stats: { recordsCreated: 6, recordsUpdated: 2 },
};
const show = () =>
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );

describe('workspace dashboard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workspace.current = { id: 'w1', name: 'Test workspace' };
    vi.mocked(api.workspaces.modules).mockResolvedValue([
      { module_id: 'tenders', module_name: 'Tenders', enabled: true },
      { module_id: 'companies', module_name: 'Companies', enabled: false },
    ]);
    vi.mocked(api.projects.listByWorkspace).mockResolvedValue([project(), project('restricted', 'companies')]);
    vi.mocked(api.records.listByProject).mockResolvedValue(six);
    vi.mocked(api.runs.listByProject).mockResolvedValue([run]);
  });

  it('uses effective module access and counts six TED/TenderNed sources as three results', async () => {
    const original = JSON.stringify(six);
    show();
    await screen.findByRole('heading', { name: 'Welkom bij Discovery Platform' });
    expect(screen.getByRole('link', { name: 'Open Tenders' })).toHaveAttribute('href', '/projects?domain=tenders');
    expect(screen.queryByRole('link', { name: 'Open Companies' })).not.toBeInTheDocument();
    expect(api.records.listByProject).not.toHaveBeenCalledWith('restricted');
    const stats = within(screen.getByRole('region', { name: 'Workspace statistieken' }));
    expect(stats.getByText('Gevonden resultaten').closest('.rounded-xl')).toHaveTextContent('3');
    expect(screen.getAllByText('2 gekoppelde bronrecords', { exact: false })).toHaveLength(3);
    expect(screen.getByText('Gedeeltelijk geslaagd')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Resultaten van Project p1, run r1/ })).toHaveAttribute(
      'href',
      '/projects/p1?run=r1',
    );
    expect(JSON.stringify(six)).toBe(original);
  });

  it('keeps projects separate when applying domain grouping', () => {
    expect(
      dashboardRecordGroups([...six, ...six.map((item) => ({ ...item, id: `other-${item.id}`, project_id: 'p2' }))]),
    ).toHaveLength(6);
  });

  it('shows empty sections and modules even before the first project', async () => {
    vi.mocked(api.projects.listByWorkspace).mockResolvedValue([]);
    show();
    expect(await screen.findByRole('link', { name: 'Open Tenders' })).toBeInTheDocument();
    expect(screen.getByText('Ruimte voor je eerste project')).toBeInTheDocument();
    expect(screen.getByText('Nog geen zoekruns')).toBeInTheDocument();
  });

  it('retains available data and explicitly marks incomplete totals when one request fails', async () => {
    vi.mocked(api.records.listByProject).mockRejectedValue(new Error('offline'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Resultaten van Project p1');
    expect(screen.getByText('Gevonden resultaten').closest('.rounded-xl')).toHaveTextContent('—');
    expect(screen.getByText('Gedeeltelijk geslaagd')).toBeInTheDocument();
  });

  it('fails closed if module access is unavailable', async () => {
    vi.mocked(api.workspaces.modules).mockRejectedValue(new Error('access unavailable'));
    show();
    expect(await screen.findByText('access unavailable')).toBeInTheDocument();
    expect(api.records.listByProject).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open Tenders' })).not.toBeInTheDocument();
  });

  it('removes previous workspace data while the next workspace loads', async () => {
    const view = show();
    await screen.findByRole('link', { name: 'Open Tenders' });
    vi.mocked(api.workspaces.modules).mockReturnValue(new Promise(() => {}));
    workspace.current = { id: 'w2', name: 'Andere workspace' };
    view.rerender(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Open Tenders' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.workspaces.modules).toHaveBeenCalledWith('w2'));
  });

  it('supports new module identifiers without changes to the dashboard', async () => {
    vi.mocked(api.workspaces.modules).mockResolvedValue([
      { module_id: 'future', module_name: 'Nieuwe module', enabled: true },
    ]);
    show();
    expect(await screen.findByRole('link', { name: 'Open Nieuwe module' })).toHaveAttribute(
      'href',
      '/projects?domain=future',
    );
  });

  it('does not load projects belonging to another workspace', async () => {
    vi.mocked(api.projects.listByWorkspace).mockResolvedValue([{ ...project(), workspace_id: 'w2' }]);
    expect((await loadDashboard('w1')).projects).toEqual([]);
    expect(api.records.listByProject).not.toHaveBeenCalled();
  });
});
