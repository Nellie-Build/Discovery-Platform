import { useState } from 'react';
import { ApiError } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { AdminTabs } from './modules';

export function AdminProjectsPage() {
  const { data: projects, loading, error, refetch } = useAsync(() => api.admin.projects.list(), []);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  async function handleRestore(id: string) {
    setRestoringId(id);
    setRestoreError(null);
    try {
      await api.admin.projects.restore(id);
      await refetch();
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : 'Could not restore the project.');
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
        <AdminTabs />
      </div>

      {loading && <LoadingState label="Loading projects…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {restoreError && <p className="text-sm text-red-600">{restoreError}</p>}

      {!loading && !error && projects && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Project</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Module</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Workspace</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Created at</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map(project => (
                <tr key={project.id}>
                  <td className="px-4 py-3 text-slate-900">{project.name}</td>
                  <td className="px-4 py-3 text-slate-700">{project.domain}</td>
                  <td className="px-4 py-3 text-slate-700">{project.workspace_name}</td>
                  <td className="px-4 py-3 text-slate-700">{new Date(project.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {project.deleted_at ? <Badge tone="danger">Deleted</Badge> : <Badge tone="success">Active</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    {project.deleted_at && (
                      <Button
                        type="button" variant="secondary" disabled={restoringId === project.id}
                        onClick={() => handleRestore(project.id)}
                      >
                        {restoringId === project.id ? 'Restoring…' : 'Restore'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
