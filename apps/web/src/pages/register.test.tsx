import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { RegisterPage } from './register';
import { AuthProvider } from '../lib/auth-context';

vi.mock('../lib/api');
import { api } from '../lib/api';

function renderRegister() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <AuthProvider>
        <RegisterPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockImplementation(async () => { throw new ApiError(401, 'unauthorized', 'Not logged in.'); });
    vi.mocked(api.auth.register).mockReset();
  });

  it('registers with the entered email/password and gets a workspace back', async () => {
    vi.mocked(api.auth.register).mockResolvedValue({
      user: { id: 'u1', email: 'new@example.com', is_admin: false, created_at: '', updated_at: '' },
      workspace: { id: 'w1', name: 'My workspace', created_at: '', updated_at: '' },
    });
    renderRegister();

    await userEvent.type(screen.getByLabelText(/email/i), 'new@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-secure-password-123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(api.auth.register).toHaveBeenCalledWith('new@example.com', 'a-secure-password-123'));
  });

  it('shows a clear message when the email is already taken', async () => {
    vi.mocked(api.auth.register).mockImplementation(() => Promise.reject(new ApiError(409, 'email_taken', 'An account with this email already exists.')));
    renderRegister();

    await userEvent.type(screen.getByLabelText(/email/i), 'existing@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-secure-password-123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('An account with this email already exists.')).toBeInTheDocument();
  });
});
