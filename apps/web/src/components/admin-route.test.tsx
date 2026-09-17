import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AdminRoute } from './admin-route';

const useAuthMock = vi.fn();
vi.mock('../lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

function renderAdminRoute() {
  return render(
    <MemoryRouter initialEntries={['/admin/modules']}>
      <Routes>
        <Route path="/" element={<div>Dashboard</div>} />
        <Route path="/admin/modules" element={<AdminRoute><div>Admin content</div></AdminRoute>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminRoute', () => {
  it('redirects a logged-in non-admin user to the dashboard — never shows admin content', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u1', email: 'a@example.com', is_admin: false }, loading: false });
    renderAdminRoute();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Admin content')).not.toBeInTheDocument();
  });

  it('shows admin content for a user whose session says is_admin: true', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u1', email: 'a@example.com', is_admin: true }, loading: false });
    renderAdminRoute();
    expect(screen.getByText('Admin content')).toBeInTheDocument();
  });

  it('shows a loading state while the session check is in flight, never a premature redirect', () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    renderAdminRoute();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin content')).not.toBeInTheDocument();
  });
});
