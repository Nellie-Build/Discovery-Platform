import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiscoveryRun } from '@discovery-platform/client';
import { StartDiscoveryForm } from './project-detail';

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
