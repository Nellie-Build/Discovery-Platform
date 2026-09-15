import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceMembership } from '@discovery-platform/client';
import { api } from './api';
import { useAuth } from './auth-context';

interface WorkspaceState {
  workspaces: WorkspaceMembership[];
  current: WorkspaceMembership | null;
  loading: boolean;
  error: string | null;
  setCurrentId(id: string): void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const STORAGE_KEY = 'discovery-platform:current-workspace-id';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setWorkspaces([]); setCurrentId(null); setLoading(false); return; }
    setLoading(true);
    api.workspaces.listMine()
      .then(list => {
        setWorkspaces(list);
        const remembered = localStorage.getItem(STORAGE_KEY);
        const stillValid = remembered && list.some(w => w.id === remembered);
        setCurrentId(stillValid ? remembered : (list[0]?.id ?? null));
        setError(null);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load workspaces.'))
      .finally(() => setLoading(false));
  }, [user]);

  const setCurrent = (id: string) => {
    setCurrentId(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  const current = workspaces.find(w => w.id === currentId) ?? null;

  return (
    <WorkspaceContext.Provider value={{ workspaces, current, loading, error, setCurrentId: setCurrent }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used within a WorkspaceProvider.');
  return context;
}
