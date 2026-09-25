import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { DiscoveryRun, Project } from '@discovery-platform/client';
import { StartDiscoveryForm, ProjectDetailPage, isNewerRun } from './project-detail';

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
    deleted_at: null, deleted_by: null,
    ...overrides,
  };
}

describe('dashboard run link', () => {
  it('loads the linked older run and its results instead of the newest run', async () => {
    vi.mocked(api.projects.get).mockResolvedValue(project());
    vi.mocked(api.runs.listByProject).mockResolvedValue([run({ id: 'new' }), run({ id: 'linked' })]);
    vi.mocked(api.records.listByProject).mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/projects/p1?run=linked']}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.records.listByProject).toHaveBeenCalledWith('p1', { runId: 'linked' }));
    expect(api.records.listByProject).not.toHaveBeenCalledWith('p1', { runId: 'new' });
  });
});

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

    expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example/careers', {
      runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: true }, filters: {},
    });
    expect(api.runs.startBranchSearch).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(startedRun);
  });

  it('switching to Branche mode hides the Website URL field and shows Branche/Land/Regio/Extra trefwoorden instead', async () => {
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));

    expect(screen.queryByLabelText('Website URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Branche')).toBeInTheDocument();
    expect(screen.getByLabelText('Land')).toHaveValue('Nederland');
    expect(screen.getByLabelText('Regio / provincie / plaats')).toBeInTheDocument();
    expect(screen.getByLabelText('Extra trefwoorden')).toBeInTheDocument();
    expect(screen.getByText('Gebruik regio/plaats voor geografische filtering. Gebruik trefwoorden voor functie, specialisme of vakgebied.')).toBeInTheDocument();
  });

  it('Branche mode: submitting calls api.runs.startBranchSearch with branch/country/region/keywords, never runs.start', async () => {
    const startedRun = run({ id: 'run2' });
    vi.mocked(api.runs.startBranchSearch).mockResolvedValue(startedRun);
    const onStarted = vi.fn();
    render(<StartDiscoveryForm projectId="p1" onStarted={onStarted} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.type(screen.getByLabelText('Branche'), 'Security');
    await userEvent.type(screen.getByLabelText('Regio / provincie / plaats'), 'Zuid-Holland');
    await userEvent.type(screen.getByLabelText('Extra trefwoorden'), 'beveiliger security officer');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', {
      branch: 'Security', country: 'Nederland', region: 'Zuid-Holland', keywords: 'beveiliger security officer',
      runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: true }, filters: {},
    });
    expect(api.runs.start).not.toHaveBeenCalled();
    expect(onStarted).toHaveBeenCalledWith(startedRun);
  });

  it('Branche mode: region and keywords are optional — omitted from the request body when left blank (the country defaults to Nederland)', async () => {
    vi.mocked(api.runs.startBranchSearch).mockResolvedValue(run({ id: 'run3' }));
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.type(screen.getByLabelText('Branche'), 'Security');
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', {
      branch: 'Security', country: 'Nederland', runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: true }, filters: {},
    });
  });

  it('Branche mode: choosing a different search breadth sends it, never a hardcoded provider count', async () => {
    vi.mocked(api.runs.startBranchSearch).mockResolvedValue(run({ id: 'run4' }));
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    await userEvent.type(screen.getByLabelText('Branche'), 'Security');
    await userEvent.click(screen.getByRole('radio', { name: 'Broad' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

    expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', {
      branch: 'Security', country: 'Nederland', runConfig: { targetRecords: 50, searchBreadth: 'broad', onlyNewRecords: true }, filters: {},
    });
  });

  it('Branche mode: the branch field is required — the form does not submit without it', async () => {
    render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
    expect(screen.getByLabelText('Branche')).toBeRequired();
  });

  describe('Zoekinstellingen', () => {
    it('choosing a target preset other than the default sends it as targetRecords', async () => {
      vi.mocked(api.runs.start).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example');
      await userEvent.click(screen.getByRole('radio', { name: '100' }));
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example', {
        runConfig: { targetRecords: 100, searchBreadth: 'standard', onlyNewRecords: true }, filters: {},
      });
    });

    it('"Aangepast" reveals a custom number field whose value becomes targetRecords', async () => {
      vi.mocked(api.runs.start).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example');
      await userEvent.click(screen.getByRole('radio', { name: 'Aangepast' }));
      const customInput = screen.getByLabelText('Aangepast aantal resultaten');
      await userEvent.clear(customInput);
      await userEvent.type(customInput, '777');
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example', {
        runConfig: { targetRecords: 777, searchBreadth: 'standard', onlyNewRecords: true }, filters: {},
      });
    });

    it('choosing "Geplaatst in" sends postedWithinDays in filters', async () => {
      vi.mocked(api.runs.start).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example');
      await userEvent.click(screen.getByRole('radio', { name: 'Laatste 7 dagen' }));
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example', {
        runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: true }, filters: { postedWithinDays: 7 },
      });
    });

    it('turning off "Alleen nieuwe resultaten" sends onlyNewRecords: false', async () => {
      vi.mocked(api.runs.start).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example');
      await userEvent.click(screen.getByRole('switch', { name: 'Alleen nieuwe resultaten' }));
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example', {
        runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: false }, filters: {},
      });
    });

    it('Website mode shows a plain "Website crawl" label instead of source checkboxes', async () => {
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);
      expect(screen.getByText('Website crawl')).toBeInTheDocument();
      expect(screen.queryByText('Indeed')).not.toBeInTheDocument();
    });

    it('Branche mode: unchecking a source sends the remaining sources explicitly; leaving every source checked omits filters.sources entirely', async () => {
      vi.mocked(api.runs.startBranchSearch).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.click(screen.getByRole('radio', { name: 'Branche' }));
      await userEvent.type(screen.getByLabelText('Branche'), 'Security');
      await userEvent.click(screen.getByLabelText('LinkedIn'));
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.startBranchSearch).toHaveBeenCalledWith('p1', {
        branch: 'Security', country: 'Nederland',
        runConfig: { targetRecords: 50, searchBreadth: 'standard', onlyNewRecords: true },
        filters: { sources: ['indeed', 'web_search'] },
      });
    });

    it('Zoekmodus "Geavanceerd" reveals maxPages/maxCandidates/maxDuration/maxEnrichments, sent only when filled in', async () => {
      vi.mocked(api.runs.start).mockResolvedValue(run());
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('Website URL'), 'https://company.example');
      await userEvent.click(screen.getByRole('radio', { name: 'Geavanceerd' }));
      await userEvent.type(screen.getByLabelText("Max pagina's"), '40');
      await userEvent.type(screen.getByLabelText('Max kandidaten'), '150');
      await userEvent.type(screen.getByLabelText('Max duur (sec)'), '120');
      await userEvent.click(screen.getByRole('button', { name: 'Start Discovery' }));

      expect(api.runs.start).toHaveBeenCalledWith('p1', 'https://company.example', {
        runConfig: {
          targetRecords: 50, searchBreadth: 'advanced', onlyNewRecords: true,
          maxPages: 40, maxCandidates: 150, maxDurationMs: 120_000,
        },
        filters: {},
      });
    });

    it('switching away from "Geavanceerd" hides the advanced fields again', async () => {
      render(<StartDiscoveryForm projectId="p1" onStarted={vi.fn()} />);
      await userEvent.click(screen.getByRole('radio', { name: 'Geavanceerd' }));
      expect(screen.getByLabelText("Max pagina's")).toBeInTheDocument();
      await userEvent.click(screen.getByRole('radio', { name: 'Standard' }));
      expect(screen.queryByLabelText("Max pagina's")).not.toBeInTheDocument();
    });
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

describe('isNewerRun', () => {
  it('accepts a run when nothing is currently shown yet', () => {
    expect(isNewerRun(run({ id: 'a', created_at: '2026-01-01T10:00:00Z' }), null)).toBe(true);
  });

  it('accepts a run created after the one currently shown (run B, started after run A, may replace it)', () => {
    const runA = run({ id: 'runA', created_at: '2026-01-01T10:00:00Z' });
    const runB = run({ id: 'runB', created_at: '2026-01-01T10:05:00Z' });
    expect(isNewerRun(runB, runA)).toBe(true);
  });

  it('rejects a run created before the one currently shown — a delayed response for run A must never overwrite run B once B is already displayed', () => {
    const runA = run({ id: 'runA', created_at: '2026-01-01T10:00:00Z' });
    const runB = run({ id: 'runB', created_at: '2026-01-01T10:05:00Z' });
    expect(isNewerRun(runA, runB)).toBe(false);
  });

  it('accepts a tie (equal created_at) so two runs started in the same instant are never both rejected', () => {
    const runA = run({ id: 'runA', created_at: '2026-01-01T10:00:00Z' });
    const runB = run({ id: 'runB', created_at: '2026-01-01T10:00:00Z' });
    expect(isNewerRun(runB, runA)).toBe(true);
  });
});

describe('ProjectDetailPage', () => {
  beforeEach(() => {
    vi.mocked(api.projects.get).mockReset().mockResolvedValue(project());
    vi.mocked(api.records.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.listByProject).mockReset().mockResolvedValue([]);
    vi.mocked(api.runs.get).mockReset();
    vi.mocked(api.runs.start).mockReset();
  });

  it('selects historical criteria and run records without presenting project history as failed-run output', async () => {
    const old = run({ id: 'education', stats: { searchMode: 'branch', branch: 'Onderwijs', criteria: { mode: 'branch', branch: 'Onderwijs', region: 'Nederland' } } });
    const current = run({ id: 'security', status: 'failed', stats: { searchMode: 'branch', branch: 'Security', stopReason: 'all_sources_failed', criteria: { mode: 'branch', branch: 'Security', region: 'Nederland' } } });
    const record = { id: 'r1', project_id: 'p1', domain: 'vacancies', status: 'new', display_name: 'Oude docent', domain_data: {}, classification: {}, score: 50, created_at: '', updated_at: '' };
    vi.mocked(api.projects.get).mockResolvedValue(project({ name: 'Security Agencies' }));
    vi.mocked(api.runs.listByProject).mockResolvedValue([current, old]);
    vi.mocked(api.records.listByProject).mockImplementation(async (_id, options) => options?.runId === 'security' ? [] : [record]);
    renderProjectDetail();
    await screen.findByText('Alle bronnen mislukt');
    expect(screen.queryByText('Oude docent')).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /Bekijk run/ })[1]);
    await screen.findByText('Oude docent');
    expect(screen.getByText('Onderwijs')).toBeInTheDocument();
    expect(api.records.listByProject).toHaveBeenCalledWith('p1', { runId: 'education' });
    await userEvent.click(screen.getAllByRole('button', { name: /Bekijk run/ })[0]);
    await screen.findByText('Geen resultaten voor deze run');
    expect(screen.queryByText('Oude docent')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Alle resultaten' }));
    await screen.findByText('Oude docent');
  });

  // "New records" appears twice on the page (the status card's own field, and the Run history
  // table's column header) — the status card is always rendered first in the DOM, above Run
  // history, so its own field is reliably the first match.
  function newRecordsValue() {
    return screen.getAllByText('New records')[0].closest('div')?.textContent?.replace('New records', '');
  }

  it('after starting a second run in the same session, the status card shows the newest run\'s own data — not the first run\'s, even though both resolve with the same "succeeded" status', async () => {
    const runA = run({ id: 'runA', created_at: '2026-01-01T10:00:00Z', stats: { recordsCreated: 1 } });
    const runB = run({ id: 'runB', created_at: '2026-01-01T10:05:00Z', stats: { recordsCreated: 9 } });
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

  it('deleting a project always shows the exact confirm dialog text, and only calls the API after the user confirms', async () => {
    vi.mocked(api.projects.delete).mockReset();
    renderProjectDetail();
    await waitFor(() => expect(screen.getByText('Test project')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(screen.getByText(
      'Project verwijderen? Dit project en de bijbehorende gegevens worden niet meer getoond. ' +
      'Deze actie kan later door een beheerder worden hersteld.',
    )).toBeInTheDocument();
    expect(api.projects.delete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.projects.delete).not.toHaveBeenCalled();
  });

  it('confirming project deletion calls the API with the project id', async () => {
    vi.mocked(api.projects.delete).mockReset().mockResolvedValue(undefined);
    renderProjectDetail();
    await waitFor(() => expect(screen.getByText('Test project')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    const dialogButtons = screen.getAllByRole('button', { name: 'Delete project' });
    await userEvent.click(dialogButtons[dialogButtons.length - 1]);

    await waitFor(() => expect(api.projects.delete).toHaveBeenCalledWith('p1'));
  });

  it('run history = A, B, C → on page load, the status card shows C (the newest run by created_at)', async () => {
    const runA = run({ id: 'runA', created_at: '2026-01-01T10:00:00Z', stats: { recordsCreated: 1 } });
    const runB = run({ id: 'runB', created_at: '2026-01-01T10:05:00Z', stats: { recordsCreated: 4 } });
    const runC = run({ id: 'runC', created_at: '2026-01-01T10:10:00Z', stats: { recordsCreated: 7 } });
    // Newest-first, exactly as the real ORDER BY created_at DESC returns them.
    vi.mocked(api.runs.listByProject).mockResolvedValue([runC, runB, runA]);

    renderProjectDetail();
    await waitFor(() => expect(newRecordsValue()).toBe('7'));
  });
});
