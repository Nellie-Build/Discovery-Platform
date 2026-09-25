import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsPage } from './projects';

vi.mock('../lib/api');
vi.mock('../lib/workspace-context', () => ({ useWorkspace: () => ({ current: { id: 'w1', name: 'Alleen aanbestedingen' } }) }));
import { api } from '../lib/api';

describe('new project form and workspace modules', () => {
  beforeEach(() => {
    vi.mocked(api.projects.listByWorkspace).mockReset().mockResolvedValue([]);
    vi.mocked(api.workspaces.modules).mockReset();
  });

  it('does not offer a module that is off for this workspace, and preselects one that is on', async () => {
    vi.mocked(api.workspaces.modules).mockResolvedValue([
      { module_id: 'tenders', module_name: 'Aanbestedingen', enabled: true },
      { module_id: 'vacancies', module_name: 'Vacatures', enabled: false },
    ]);
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await userEvent.click((await screen.findAllByRole('button', { name: 'New project' }))[0]);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Vacancies (not enabled for this workspace)' })).toBeDisabled());
    expect(api.workspaces.modules).toHaveBeenCalledWith('w1');
    expect(screen.getByRole('option', { name: 'Tenders' })).toBeEnabled();
    expect(screen.getByLabelText('Domain')).toHaveValue('tenders');
  });

  it('keeps the plain list when the workspace modules cannot be loaded (the API still decides)', async () => {
    vi.mocked(api.workspaces.modules).mockRejectedValue(new Error('offline'));
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await userEvent.click((await screen.findAllByRole('button', { name: 'New project' }))[0]);
    expect(screen.getByRole('option', { name: 'Vacancies' })).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Tenders' })).toBeEnabled();
    expect(screen.getByLabelText('Domain')).toHaveValue('vacancies');
  });
});
