import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, type PublicUser } from '@discovery-platform/client';
import { api } from './api';

interface AuthState {
  user: PublicUser | null;
  /** True only while the initial /auth/me check is in flight — never shown again after that. */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const currentUser = await api.auth.me();
        if (!cancelled) setUser(currentUser);
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof ApiError && error.status === 401)) console.error(error);
        setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const loggedInUser = await api.auth.login(email, password);
    setUser(loggedInUser);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const result = await api.auth.register(email, password);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider.');
  return context;
}
