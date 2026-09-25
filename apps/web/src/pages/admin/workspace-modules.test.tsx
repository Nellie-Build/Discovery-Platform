import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AdminWorkspaceModules, WorkspaceModuleAccess } from '@discovery-platform/client';
import { AdminWorkspaceModulesPage } from './workspace-modules';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

const access = (module_id: string, module_name: string, global_enabled: boolean, workspace_enabled: boolean | null): WorkspaceModuleAccess => ({
  module_id, module_name, global_enabled, workspace_enabled, enabled: global_enabled && workspace_enabled !== false,
});
const workspaces: AdminWorkspaceModules[] = [
  { workspace_id: 'w1', workspace_name: 'Alleen vacatures', modules: [access('housing', 'Woningen', false, null), access('tenders', 'Aanbestedingen', true, false), access('vacancies', 'Vacatures', true, null)] },
  { workspace_id: 'w2', workspace_name: 'Beide', modules: [access('housing', 'Woningen', false, null), access('tenders', 'Aanbestedingen', true, null), access('vacancies', 'Vacatures', true, null)] },
];

describe('AdminWorkspaceModulesPage', () => {
  beforeEach(() => {
    vi.mocked(api.admin.workspaceModules.list).mockReset().mockResolvedValue(workspaces);
    vi.mocked(api.admin.workspaceModules.set).mockReset().mockResolvedValue(workspaces[0].modules[1]);
  });

  it('shows every workspace x module with its own decision, the default and whether it is available', async () => {
    render(<MemoryRouter><AdminWorkspaceModulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Alleen vacatures')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: /Woningen.*off globally/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Aanbestedingen for Alleen vacatures' })).toHaveValue('off');
    expect(screen.getByRole('combobox', { name: 'Aanbestedingen for Beide' })).toHaveValue('default');
    const row = within(screen.getByRole('row', { name: /Alleen vacatures/ }));
    expect(row.getAllByText('Unavailable')).toHaveLength(2);
    expect(row.getByText('Available')).toBeInTheDocument();
  });

  it('switching a module per workspace calls the API with true, false or null (back to default) and reloads', async () => {
    render(<MemoryRouter><AdminWorkspaceModulesPage /></MemoryRouter>);
    const tendersForBoth = await screen.findByRole('combobox', { name: 'Aanbestedingen for Beide' });
    await userEvent.selectOptions(tendersForBoth, 'off');
    expect(api.admin.workspaceModules.set).toHaveBeenLastCalledWith('w2', 'tenders', false);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Aanbestedingen for Alleen vacatures' }), 'default');
    expect(api.admin.workspaceModules.set).toHaveBeenLastCalledWith('w1', 'tenders', null);
    await waitFor(() => expect(api.admin.workspaceModules.list).toHaveBeenCalledTimes(3));
  });
});
