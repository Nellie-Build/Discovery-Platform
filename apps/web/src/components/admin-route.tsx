import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth-context';
import { LoadingState } from './ui/states';

/** Guards every /admin/* route — reads `user.is_admin` from the session the API already
 * returned (see migrations/004_admin_modules.sql), never a hardcoded email. A non-admin is sent
 * back to the dashboard; the server enforces the same check independently on every /admin/*
 * request (see apps/api/src/admin-access.ts), so this is a UX nicety, never the real gate. */
export function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <LoadingState label="Loading…" />;
  if (!user?.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
