import { useState } from 'react';
import { ApiError, type WorkspaceModuleAccess } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { Badge } from '../../components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { AdminTabs } from './modules';

type Choice = 'default' | 'on' | 'off';
const choiceOf = (access: WorkspaceModuleAccess): Choice => (access.workspace_enabled === null ? 'default' : access.workspace_enabled ? 'on' : 'off');
const valueOf: Record<Choice, boolean | null> = { default: null, on: true, off: false };

/**
 * Per-workspace module access. The global switch (Modules tab) stays the master switch: a module that is off
 * globally is off everywhere. Per workspace a module follows that switch ("Default") or is explicitly on or off.
 * Switching a module off never touches existing projects or records; it only stops new projects and runs.
 */
export function AdminWorkspaceModulesPage() {
  const { data: workspaces, loading, error, refetch } = useAsync(() => api.admin.workspaceModules.list(), []);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleChange(workspaceId: string, moduleId: string, choice: Choice) {
    const key = `${workspaceId}/${moduleId}`;
    setSaving(key);
    setSaveError(null);
    try {
      await api.admin.workspaceModules.set(workspaceId, moduleId, valueOf[choice]);
      await refetch();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not update the module access.');
    } finally {
      setSaving(null);
    }
  }

  const modules = workspaces?.[0]?.modules ?? [];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
        <AdminTabs />
      </div>
      <p className="text-sm text-slate-500">
        Which modules each workspace may use for new projects and runs. <strong>Default</strong> follows the global switch on the Modules tab;
        a module that is off globally is off in every workspace. Existing projects and records always stay readable.
      </p>

      {loading && <LoadingState label="Loading workspaces…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {saveError && <p className="text-sm text-red-600">{saveError}</p>}
      {!loading && !error && workspaces && workspaces.length === 0 && <EmptyState title="No workspaces yet" />}

      {!loading && !error && workspaces && workspaces.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Workspace</th>
                {modules.map(module => (
                  <th key={module.module_id} className="px-4 py-3 text-left font-medium text-slate-500">
                    {module.module_name}
                    {!module.global_enabled && <span className="block text-xs font-normal text-slate-400">off globally</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {workspaces.map(workspace => (
                <tr key={workspace.workspace_id}>
                  <td className="px-4 py-3 font-medium text-slate-900">{workspace.workspace_name}</td>
                  {workspace.modules.map(access => (
                    <td key={access.module_id} className="px-4 py-3">
                      <select
                        aria-label={`${access.module_name} for ${workspace.workspace_name}`}
                        value={choiceOf(access)}
                        disabled={saving === `${workspace.workspace_id}/${access.module_id}`}
                        onChange={e => handleChange(workspace.workspace_id, access.module_id, e.target.value as Choice)}
                        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                      >
                        <option value="default">Default ({access.global_enabled ? 'on' : 'off'})</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                      <Badge tone={access.enabled ? 'success' : 'neutral'} className="ml-2 align-middle">{access.enabled ? 'Available' : 'Unavailable'}</Badge>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
