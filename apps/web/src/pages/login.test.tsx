import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { LoginPage } from './login';
import { AuthProvider } from '../lib/auth-context';

vi.mock('../lib/api');
import { api } from '../lib/api';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockImplementation(async () => { throw new ApiError(401, 'unauthorized', 'Not logged in.'); });
    vi.mocked(api.auth.login).mockReset();
  });

  it('submits the entered email/password to auth.login', async () => {
    vi.mocked(api.auth.login).mockResolvedValue({ id: 'u1', email: 'a@example.com', created_at: '', updated_at: '' });
    renderLogin();

    await waitFor(() => expect(screen.getByLabelText(/email/i)).not.toBeDisabled());
    await userEvent.type(screen.getByLabelText(/email/i), 'a@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-secure-password-123');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(api.auth.login).toHaveBeenCalledWith('a@example.com', 'a-secure-password-123'));
  });

  it('shows the server\'s error message on invalid credentials, without crashing', async () => {
    vi.mocked(api.auth.login).mockImplementation(() => Promise.reject(new ApiError(401, 'invalid_credentials', 'Invalid email or password.')));
    renderLogin();

    await waitFor(() => expect(screen.getByLabelText(/email/i)).not.toBeDisabled());
    await userEvent.type(screen.getByLabelText(/email/i), 'a@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
  });

  it('links to the register page', async () => {
    renderLogin();
    await waitFor(() => expect(screen.getByLabelText(/email/i)).not.toBeDisabled());
    expect(screen.getByRole('link', { name: /create one/i })).toHaveAttribute('href', '/register');
  });
});
