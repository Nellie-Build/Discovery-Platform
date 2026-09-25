import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AdminWorkspaceModules, ModulePackage, WorkspaceModuleAccess } from '@discovery-platform/client';
import { AdminWorkspaceModulesPage } from './workspace-modules';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

const access = (module_id: string, module_name: string, global_enabled: boolean, package_included: boolean, workspace_enabled: boolean | null): WorkspaceModuleAccess => ({
  module_id, module_name, global_enabled, package_included, workspace_enabled,
  deviates: workspace_enabled !== null && workspace_enabled !== package_included,
  enabled: global_enabled && (workspace_enabled ?? package_included),
});
const packages: ModulePackage[] = [
  { id: 'vacancies', name: 'Vacancies', description: '', is_custom: false, sort_order: 1, module_ids: ['vacancies'] },
  { id: 'tenders', name: 'Tenders', description: '', is_custom: false, sort_order: 2, module_ids: ['tenders'] },
  { id: 'complete', name: 'Compleet', description: '', is_custom: false, sort_order: 3, module_ids: ['tenders', 'vacancies'] },
  { id: 'custom', name: 'Maatwerk', description: '', is_custom: true, sort_order: 4, module_ids: [] },
];
const workspaces: AdminWorkspaceModules[] = [
  { workspace_id: 'w1', workspace_name: 'Alleen vacatures', package_id: 'vacancies', package_name: 'Vacancies', customized: false,
    modules: [access('housing', 'Woningen', false, false, null), access('tenders', 'Aanbestedingen', true, false, null), access('vacancies', 'Vacatures', true, true, null)] },
  { workspace_id: 'w2', workspace_name: 'Compleet zonder tenders', package_id: 'complete', package_name: 'Compleet', customized: true,
    modules: [access('housing', 'Woningen', false, false, null), access('tenders', 'Aanbestedingen', true, true, false), access('vacancies', 'Vacatures', true, true, null)] },
];

describe('AdminWorkspaceModulesPage', () => {
  beforeEach(() => {
    vi.mocked(api.admin.workspaceModules.list).mockReset().mockResolvedValue(workspaces);
    vi.mocked(api.admin.modulePackages.list).mockReset().mockResolvedValue(packages);
    vi.mocked(api.admin.workspaceModules.set).mockReset().mockResolvedValue(workspaces[0].modules[1]);
    vi.mocked(api.admin.workspaceModules.setPackage).mockReset().mockResolvedValue([]);
  });

  it('shows each workspace\'s package, what it makes available, and marks a package that was adjusted', async () => {
    render(<MemoryRouter><AdminWorkspaceModulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Alleen vacatures')).toBeInTheDocument());
    const packageSelect = screen.getByRole('combobox', { name: 'Package for Alleen vacatures' });
    expect(packageSelect).toHaveValue('vacancies');
    expect(within(packageSelect).getAllByRole('option').map(o => o.textContent)).toEqual(['Vacancies', 'Tenders', 'Compleet', 'Maatwerk']);
    expect(screen.getByRole('columnheader', { name: /Woningen.*off globally/ })).toBeInTheDocument();

    const plain = within(screen.getByRole('row', { name: /Alleen vacatures/ }));
    expect(plain.queryByText('Adjusted')).not.toBeInTheDocument();
    const tenders = plain.getByRole('combobox', { name: 'Aanbestedingen for Alleen vacatures' });
    expect(tenders).toHaveValue('package');
    expect(within(tenders).getByRole('option', { name: 'Package (off)' })).toBeInTheDocument();
    expect(within(plain.getByRole('combobox', { name: 'Vacatures for Alleen vacatures' })).getByRole('option', { name: 'Package (on)' })).toBeInTheDocument();

    const adjusted = within(screen.getByRole('row', { name: /Compleet zonder tenders/ }));
    expect(adjusted.getByText('Adjusted')).toBeInTheDocument();
    expect(adjusted.getByRole('combobox', { name: 'Aanbestedingen for Compleet zonder tenders' })).toHaveValue('off');
    expect(adjusted.getByText('differs from package')).toBeInTheDocument();
    expect(adjusted.getAllByText('Available')).toHaveLength(1);
  });

  it('picking a package or a module choice calls the API and reloads', async () => {
    render(<MemoryRouter><AdminWorkspaceModulesPage /></MemoryRouter>);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Package for Alleen vacatures' }), 'complete');
    expect(api.admin.workspaceModules.setPackage).toHaveBeenLastCalledWith('w1', 'complete');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Aanbestedingen for Compleet zonder tenders' }), 'package');
    expect(api.admin.workspaceModules.set).toHaveBeenLastCalledWith('w2', 'tenders', null);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Vacatures for Alleen vacatures' }), 'off');
    expect(api.admin.workspaceModules.set).toHaveBeenLastCalledWith('w1', 'vacancies', false);
    await waitFor(() => expect(api.admin.workspaceModules.list).toHaveBeenCalledTimes(4));
  });
});
