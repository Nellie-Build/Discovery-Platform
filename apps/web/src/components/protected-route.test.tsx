import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from './protected-route';

// ProtectedRoute only ever reads useAuth()'s return value — mocking that hook directly (rather
// than rendering a real AuthProvider around a mocked, rejecting API call) tests the exact same
// redirect/loading logic without depending on exactly when a promise settles relative to
// render, which is what AuthProvider's own tests (via login/register pages) already cover.
const useAuthMock = vi.fn();
vi.mock('../lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

function renderProtected() {
  return render(
    <MemoryRouter initialEntries={['/records']}>
      <Routes>
        <Route path="/login" element={<div>Login screen</div>} />
        <Route path="/records" element={<ProtectedRoute><div>Secret records</div></ProtectedRoute>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('shows a loading state while the session check is still in flight — never the protected content or a premature redirect', () => {
    useAuthMock.mockReturnValue({ user: null, loading: true });
    renderProtected();
    expect(screen.queryByText('Secret records')).not.toBeInTheDocument();
    expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
  });

  it('redirects to /login when there is no session — unauthorized access is never shown', () => {
    useAuthMock.mockReturnValue({ user: null, loading: false });
    renderProtected();
    expect(screen.getByText('Login screen')).toBeInTheDocument();
    expect(screen.queryByText('Secret records')).not.toBeInTheDocument();
  });

  it('renders the protected content once a session is confirmed', () => {
    useAuthMock.mockReturnValue({ user: { id: 'u1', email: 'a@example.com' }, loading: false });
    renderProtected();
    expect(screen.getByText('Secret records')).toBeInTheDocument();
  });
});
