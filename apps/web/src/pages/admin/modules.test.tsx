import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { DiscoveryModuleDefinition } from '@discovery-platform/client';
import { AdminModulesPage } from './modules';

vi.mock('../../lib/api');
import { api } from '../../lib/api';

function module(overrides: Partial<DiscoveryModuleDefinition> = {}): DiscoveryModuleDefinition {
  return {
    id: 'vacancies', name: 'Vacatures', description: '', enabled: true, status: 'active',
    version: '1.0.0', capabilities: [], config: {}, updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('AdminModulesPage', () => {
  beforeEach(() => {
    vi.mocked(api.admin.modules.list).mockReset();
    vi.mocked(api.admin.modules.setEnabled).mockReset();
  });

  it('renders every module from the registry with its status and enabled state', async () => {
    vi.mocked(api.admin.modules.list).mockResolvedValue([
      module({ id: 'vacancies', name: 'Vacatures', enabled: true, status: 'active' }),
      module({ id: 'companies', name: 'Bedrijven', enabled: false, status: 'coming_soon' }),
    ]);
    render(<MemoryRouter><AdminModulesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Vacatures')).toBeInTheDocument());
    expect(screen.getByText('Bedrijven')).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Vacatures enabled' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Bedrijven enabled' })).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling a module off calls the API and refreshes the list', async () => {
    vi.mocked(api.admin.modules.list)
      .mockResolvedValueOnce([module({ enabled: true })])
      .mockResolvedValueOnce([module({ enabled: false, status: 'disabled' })]);
    vi.mocked(api.admin.modules.setEnabled).mockResolvedValue(module({ enabled: false }));
    render(<MemoryRouter><AdminModulesPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('switch', { name: 'Vacatures enabled' })).toHaveAttribute('aria-checked', 'true'));
    await userEvent.click(screen.getByRole('switch', { name: 'Vacatures enabled' }));

    expect(api.admin.modules.setEnabled).toHaveBeenCalledWith('vacancies', false);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Vacatures enabled' })).toHaveAttribute('aria-checked', 'false'));
  });
});
