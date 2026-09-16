import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { DiscoveryRun, Project } from '@discovery-platform/client';
import { StartDiscoveryForm, ProjectDetailPage } from './project-detail';

vi.mock('../lib/api');
import { api } from '../lib/api';

function run(overrides: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    id: 'run1', project_id: 'p1', status: 'succeeded',
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    stats: {}, error: null, created_at: new Date().toISOString(),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1', workspace_id: 'w1', name: 'Test project', domain: 'vacancies', status: 'active',
    config: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('StartDiscoveryForm', () => {
  beforeEach(() => {
    vi.mocked(api.runs.start).mockReset();
    vi.mocked(api.runs.startBranchSearch).mockReset();
  });

  it('defaults to Website mode, unchanged: submitting calls api.runs.start with the sourceUrl, never startBranchSearch', async () => {
    const startedRun = run({ id: 'run1' });
    vi.mocked(api.runs.start).mockResolvedValue(startedRun);
    const onStarted = vi.fn();
    render(<StartDiscoveryForm projectId="p1" onStarted={onStarted} />);

    await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example/careers');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example/careers');
    expect(api.runs.startBranchSearch).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(startedRun);
  });

  it('switching to Branche mode hides the Website URL field and shows Branche/Regio/Extra trefwoorden instead', async () => {
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));

    expect(screen.queryByLabelText('Website URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Branche')).toBeInTheDocument();
    expect(screen.getByLabelText('Regio')).toBeInTheDocument();
    expect(screen.getByLabelText('Extra trefwoorden')).toBeInTheDocument();
  });

  it('Branche mode: submitting calls api.runs.startBranchSearch with branch/region/keywords, never runs.start', async () => {
    const startedRun = run({ id: 'run2' });
    vi.mocked(api.runs.startBranchSearch).mockResolvedValue(startedRun);
    const onStarted = vi.fn();
    render(<StartDiscoveryForm projectId="p1" onStarted={onStarted} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.type(screen.getByLabelText('Branche'), 'Security');
    await userEvent.type(screen.getByLabelText('Regio'), 'Nederland');
    await userEvent.type(screen.getByLabelText('Extra trefwoorden'), 'beveiliger security officer');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', { branch: 'Security', region: 'Nederland', keywords: 'beveiliger security officer' });
    expect(api.runs.start).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(startedRun);
  });

  it('Branche mode: region and keywords are optional — omitted from the request body when left blank', async () => {
    vi.mocked(api.runs.startBranchSearch).mockResolvedValue(run({ id: 'run3' }));
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.type(screen.getByLabelText('Branche'), 'Security');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', { branch: 'Security' });
  });

  it('Branche mode: the branch field is required — the form does not submit without it', async () => {
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    expect(screen.getByLabelText('Branche')).toBeRequired();
  });

  it('switching back to Website mode restores the Website URL field and hides the branch fields', async () => {
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Website' }));
    expect(screen.getByLabelText('Website URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Branche')).not.toBeInTheDocument();
  });
});

function renderProjectDetail() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('ProjectDetailPage', () => {
  beforeEach(() => {
    vi.mocked(api.projects.get).mockReset().mockResolvedValue(project());
    vi.mocked(api.records.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.get).mockReset();
    vi.mocked(api.runs.start).mockReset();
  });

  // "New records" appears twice on the page (the status card's own field, and the Run history
  // table's column header) — the status card is always rendered first in the DOM, above Run
  // history, so its own field is reliably the first match.
  function newRecordsValue() {
    return screen.getAllByText('New records')[0].closest('div')?.textContent?.replace('New records', '');
  }

  it('after starting a second run in the same session, the status card shows the newest run\'s own data — not the first run\'s, even though both resolve with the same "succeeded" status', async () => {
    const runA = run({ id: 'runA', stats: { recordsCreated: 1 } });
    const runB = run({ id: 'runB', stats: { recordsCreated: 9 } });
    vi.mocked(api.runs.get).mockImplementation(async id => (id === 'runA' ? runA : runB));
    vi.mocked(api.runs.start).mockResolvedValueOnce(runA).mockResolvedValueOnce(runB);

    renderProjectDetail();
    await waitFor(() => expect(screen.getByLabelText('Website URL')).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText('Website URL'), 'https://a.example');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));
    await waitFor(() => expect(newRecordsValue()).toBe('1'));

    await userEvent.clear(screen.getByLabelText('Website URL'));
    await userEvent.type(screen.getByLabelText('Website URL'), 'https://b.example');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    await waitFor(() => expect(newRecordsValue()).toBe('9'));
  });

  it('on a fresh load (a refresh), the most recent run from Run history is shown in the status card — no active/polled run yet', async () => {
    const olderRun = run({ id: 'older', created_at: '2026-01-01T10:00:00Z', stats: { recordsCreated: 1 } });
    const newestRun = run({ id: 'newest', created_at: '2026-01-01T10:05:00Z', stats: { recordsCreated: 7 } });
    // listRunsByProject is already newest-first (see packages/discovery-db's own ORDER BY) — the
    // mock mirrors that real ordering rather than re-sorting client-side.
    vi.mocked(api.runs.listByProject).mockResolvedValue([newestRun, olderRun]);

    renderProjectDetail();
    await waitFor(() => expect(newRecordsValue()).toBe('7'));
  });
});
