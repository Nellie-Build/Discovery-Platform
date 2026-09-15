import { Link } from 'react-router-dom';
import type { DiscoveryRun, Project } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace-context';
import { useAsync } from '../hooks/use-async';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/states';
import { Badge, statusBadgeTone } from '../components/ui/badge';

async function loadAllRuns(workspaceId: string): Promise<{ projects: Project[]; runs: DiscoveryRun[] }> {
  const projects = await api.projects.listByWorkspace(workspaceId);
  const runs = (await Promise.all(projects.map(p => api.runs.listByProject(p.id)))).flat();
  runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return { projects, runs };
}

export function RunsPage() {
  const { current } = useWorkspace();
  const { data, loading, error, refetch } = useAsync(
    () => (current ? loadAllRuns(current.id) : Promise.resolve({ projects: [], runs: [] })),
    [current?.id],
  );

  if (loading) return <LoadingState label="Loading Discovery runs…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  if (data.runs.length === 0) {
    return <EmptyState title="No Discovery runs yet" description="Open a project and start Discovery to see its run history here." />;
  }

  const projectById = new Map(data.projects.map(p => [p.id, p]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Discovery Runs</h1>
        <p className="mt-1 text-sm text-slate-500">Every Discovery run started across {current?.name}.</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[640px] divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Project</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Started</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
              <th className="px-4 py-3 text-left font-medium text-slate-500">New records</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.runs.map(run => (
              <tr key={run.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/projects/${run.project_id}`} className="font-medium text-brand-700 hover:underline">
                    {projectById.get(run.project_id)?.name ?? 'Project'}
                  </Link>
                </td>
                <td className="px-4 py-3 text-slate-700">{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</td>
                <td className="px-4 py-3"><Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge></td>
                <td className="px-4 py-3 text-slate-700">{typeof run.stats?.recordsCreated === 'number' ? run.stats.recordsCreated : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
