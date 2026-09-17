import { useState } from 'react';
import type { DiscoveryRecord, Project } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace-context';
import { useAsync } from '../hooks/use-async';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/states';
import { RecordsTable } from '../components/records-table';

async function loadAllRecords(workspaceId: string): Promise<{ projects: Project[]; records: DiscoveryRecord[] }> {
  const projects = await api.projects.listByWorkspace(workspaceId);
  const records = (await Promise.all(projects.map(p => api.records.listByProject(p.id)))).flat();
  records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return { projects, records };
}

export function RecordsPage() {
  const { current } = useWorkspace();
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const { data, loading, error, refetch } = useAsync(
    () => (current ? loadAllRecords(current.id) : Promise.resolve({ projects: [], records: [] })),
    [current?.id],
  );

  if (loading) return <LoadingState label="Loading records…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  if (data.projects.length === 0) {
    return <EmptyState title="No projects yet" description="Records will show up here once a project has run a Discovery scan." />;
  }

  const visibleRecords = projectFilter === 'all' ? data.records : data.records.filter(r => r.project_id === projectFilter);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Records</h1>
          <p className="mt-1 text-sm text-slate-500">Every lead Discovery Platform has found across {current?.name}.</p>
        </div>
        <select
          value={projectFilter}
          onChange={e => setProjectFilter(e.target.value)}
          className="rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm shadow-sm hover:border-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 transition-colors duration-200"
        >
          <option value="all">All projects</option>
          {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>

      <RecordsTable
        records={visibleRecords}
        emptyTitle="No records found yet"
        emptyDescription="Start a Discovery run from a project to find your first leads."
      />
    </div>
  );
}
