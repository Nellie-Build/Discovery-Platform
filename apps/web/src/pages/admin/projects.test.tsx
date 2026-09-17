import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AdminProject } from '@discovery-platform/client';
import { AdminProjectsPage } from './projects';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

function adminProject(overrides: Partial<AdminProject> = {}): AdminProject {
  return {
    id: 'p1', workspace_id: 'w1', workspace_name: 'Acme workspace', name: 'A project', domain: 'vacancies',
    status: 'active', config: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    deleted_at: null, deleted_by: null,
    ...overrides,
  };
}

describe('AdminProjectsPage', () => {
  beforeEach(() => {
    vi.mocked(api.admin.projects.list).mockReset();
    vi.mocked(api.admin.projects.restore).mockReset();
  });

  it('shows both active and soft-deleted projects, with a Restore action only for deleted ones', async () => {
    vi.mocked(api.admin.projects.list).mockResolvedValue([
      adminProject({ id: 'active1', name: 'Active project', deleted_at: null }),
      adminProject({ id: 'deleted1', name: 'Deleted project', deleted_at: new Date().toISOString() }),
    ]);
    render(<MemoryRouter><AdminProjectsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Active project')).toBeInTheDocument());
    expect(screen.getByText('Deleted project')).toBeInTheDocument();
    expect(screen.getAllByText('Acme workspace')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(1);
  });

  it('restoring a deleted project calls the API and refreshes the list', async () => {
    vi.mocked(api.admin.projects.list)
      .mockResolvedValueOnce([adminProject({ id: 'deleted1', name: 'Deleted project', deleted_at: new Date().toISOString() })])
      .mockResolvedValueOnce([adminProject({ id: 'deleted1', name: 'Deleted project', deleted_at: null })]);
    vi.mocked(api.admin.projects.restore).mockResolvedValue(adminProject({ id: 'deleted1', deleted_at: null }));
    render(<MemoryRouter><AdminProjectsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(api.admin.projects.restore).toHaveBeenCalledWith('deleted1');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument());
  });
});
