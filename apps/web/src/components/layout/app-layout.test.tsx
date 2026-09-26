import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout } from './app-layout';
vi.mock('../../lib/api');
const state = vi.hoisted(() => ({
  user: { email: 'test@example.test', is_admin: false },
  logout: vi.fn(),
  current: { id: 'w1', name: 'Workspace A' },
  setCurrentId: vi.fn(),
}));
vi.mock('../../lib/auth-context', () => ({ useAuth: () => state }));
vi.mock('../../lib/workspace-context', () => ({
  useWorkspace: () => ({ ...state, loading: false, workspaces: [state.current, { id: 'w2', name: 'Workspace B' }] }),
}));
import { api } from '../../lib/api';
describe('application navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user.is_admin = false;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.mocked(api.workspaces.modules).mockResolvedValue([
      { module_id: 'tenders', module_name: 'Tenders', enabled: true },
      { module_id: 'companies', module_name: 'Companies', enabled: false },
    ]);
  });
  it('only lists available modules and highlights the selected module instead of every project link', async () => {
    render(
      <MemoryRouter initialEntries={['/projects?domain=tenders']}>
        <AppLayout />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Tenders' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Projecten' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });
  it('offers admin navigation only for an administrator', async () => {
    state.user.is_admin = true;
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });
  it('opens an accessible mobile dialog, closes on navigation and preserves workspace switching', async () => {
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Navigatie openen' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigatie' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Current workspace'), 'w2');
    expect(state.setCurrentId).toHaveBeenCalledWith('w2');
    await userEvent.click(within(dialog).getByRole('link', { name: 'Projecten' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Navigatie openen' })).toHaveFocus();
  });
  it('closes on the native Escape/cancel event', async () => {
    render(
      <MemoryRouter>
        <AppLayout />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Navigatie openen' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
