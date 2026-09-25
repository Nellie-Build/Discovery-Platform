import { useState } from 'react';
import { ApiError, type WorkspaceModuleAccess } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { Badge } from '../../components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { AdminTabs } from './modules';

type Choice = 'package' | 'on' | 'off';
const choiceOf = (access: WorkspaceModuleAccess): Choice => (access.workspace_enabled === null ? 'package' : access.workspace_enabled ? 'on' : 'off');
const valueOf: Record<Choice, boolean | null> = { package: null, on: true, off: false };

/**
 * Per-workspace module access: a package per workspace (Vacancies, Tenders, Compleet, Maatwerk, ...) plus individual
 * choices per module. The global switch (Modules tab) always wins: a module that is off globally is off everywhere.
 * A choice that differs from the package marks the workspace as adjusted. Changing access never touches existing
 * projects or records; it only decides about new projects and runs.
 */
export function AdminWorkspaceModulesPage() {
  const { data, loading, error, refetch } = useAsync(
    async () => ({ workspaces: await api.admin.workspaceModules.list(), packages: await api.admin.modulePackages.list() }),
    [],
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(key: string, action: () => Promise<unknown>) {
    setSaving(key);
    setSaveError(null);
    try {
      await action();
      await refetch();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not update the module access.');
    } finally {
      setSaving(null);
    }
  }

  const workspaces = data?.workspaces;
  const packages = data?.packages ?? [];
  const modules = workspaces?.[0]?.modules ?? [];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
        <AdminTabs />
      </div>
      <p className="text-sm text-slate-500">
        Pick a package per workspace; a module can still be switched on or off individually. Picking a package starts clean
        from that package; <strong>Maatwerk</strong> keeps the current modules and sets each one individually. A module that is
        off globally (Modules tab) is off in every workspace. Existing projects and records always stay readable.
      </p>

      {loading && <LoadingState label="Loading workspaces…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {saveError && <p className="text-sm text-red-600">{saveError}</p>}
      {!loading && !error && workspaces && workspaces.length === 0 && <EmptyState title="No workspaces yet" />}

      {!loading && !error && workspaces && workspaces.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[760px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Workspace</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Package</th>
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
                  <td className="px-4 py-3 whitespace-nowrap">
                    <select
                      aria-label={`Package for ${workspace.workspace_name}`}
                      value={workspace.package_id}
                      disabled={saving === `${workspace.workspace_id}/package`}
                      onChange={e => save(`${workspace.workspace_id}/package`, () => api.admin.workspaceModules.setPackage(workspace.workspace_id, e.target.value))}
                      className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                    >
                      {packages.map(pkg => <option key={pkg.id} value={pkg.id}>{pkg.name}</option>)}
                    </select>
                    {workspace.customized && <Badge tone="warning" className="ml-2 align-middle">Adjusted</Badge>}
                  </td>
                  {workspace.modules.map(access => (
                    <td key={access.module_id} className="px-4 py-3 whitespace-nowrap">
                      <select
                        aria-label={`${access.module_name} for ${workspace.workspace_name}`}
                        value={choiceOf(access)}
                        disabled={saving === `${workspace.workspace_id}/${access.module_id}`}
                        onChange={e => save(`${workspace.workspace_id}/${access.module_id}`, () => api.admin.workspaceModules.set(workspace.workspace_id, access.module_id, valueOf[e.target.value as Choice]))}
                        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                      >
                        <option value="package">Package ({access.package_included ? 'on' : 'off'})</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                      <Badge tone={access.enabled ? 'success' : 'neutral'} className="ml-2 align-middle">{access.enabled ? 'Available' : 'Unavailable'}</Badge>
                      {access.deviates && <span className="block text-xs text-amber-700">differs from package</span>}
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
