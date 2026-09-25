import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { clsx } from 'clsx';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { Badge } from '../../components/ui/badge';
import { LoadingState, ErrorState } from '../../components/ui/states';

const ADMIN_TABS = [
  { to: '/admin/modules', label: 'Modules' },
  { to: '/admin/workspace-modules', label: 'Workspaces' },
  { to: '/admin/projects', label: 'Projects' },
];

export function AdminTabs() {
  return (
    <nav className="flex gap-1 border-b border-slate-200">
      {ADMIN_TABS.map(tab => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            clsx(
              'border-b-2 px-4 py-2.5 text-sm font-medium transition-all duration-200',
              isActive ? 'border-brand-600 text-brand-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-b-2 hover:border-slate-300',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

function statusLabel(status: string): string {
  return status === 'active' ? 'Active' : status === 'coming_soon' ? 'Coming soon' : status;
}

export function AdminModulesPage() {
  const { data: modules, loading, error, refetch } = useAsync(() => api.admin.modules.list(), []);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function handleToggle(id: string, enabled: boolean) {
    setTogglingId(id);
    setToggleError(null);
    try {
      await api.admin.modules.setEnabled(id, enabled);
      await refetch();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : 'Could not update the module.');
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Admin</h1>
        <AdminTabs />
      </div>

      {loading && <LoadingState label="Loading modules…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {toggleError && <p className="text-sm text-red-600">{toggleError}</p>}

      {!loading && !error && modules && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[480px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Module</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-slate-500">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {modules.map(module => (
                <tr key={module.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{module.name}</p>
                    <p className="text-xs text-slate-400">{module.description}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={module.status === 'active' ? 'success' : 'neutral'}>{statusLabel(module.status)}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={module.enabled}
                      aria-label={`${module.name} enabled`}
                      disabled={togglingId === module.id}
                      onClick={() => handleToggle(module.id, !module.enabled)}
                      className={clsx(
                        'relative h-6 w-11 rounded-full transition-all duration-200 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2',
                        module.enabled ? 'bg-brand-600 shadow-md' : 'bg-slate-300 shadow-sm',
                      )}
                    >
                      <span
                        className={clsx(
                          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200',
                          module.enabled ? 'translate-x-[22px]' : 'translate-x-0.5',
                        )}
                      />
                    </button>
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
