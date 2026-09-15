import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context';
import { LoadingState } from './ui/states';

/** Redirects to /login when there is no session, remembering where the user was headed so
 * login can send them back. Shows a loading state only during the initial /auth/me check. */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingState label="Loading Discovery Platform…" />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
