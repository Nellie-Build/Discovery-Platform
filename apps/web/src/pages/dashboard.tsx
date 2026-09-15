import { Link } from 'react-router-dom';
import type { DiscoveryRecord, DiscoveryRun, Project } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace-context';
import { useAsync } from '../hooks/use-async';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, statusBadgeTone } from '../components/ui/badge';
import { LinkButton } from '../components/ui/link-button';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/states';
import { getDomainRenderer } from '../domains/registry';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface DashboardData {
  projects: Project[];
  records: DiscoveryRecord[];
  runs: DiscoveryRun[];
}

async function loadDashboard(workspaceId: string): Promise<DashboardData> {
  const projects = await api.projects.listByWorkspace(workspaceId);
  const [records, runs] = await Promise.all([
    Promise.all(projects.map(p => api.records.listByProject(p.id))).then(lists => lists.flat()),
    Promise.all(projects.map(p => api.runs.listByProject(p.id))).then(lists => lists.flat()),
  ]);
  return { projects, records, runs };
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="py-5">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-1 text-3xl font-semibold text-slate-900">{value}</p>
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { current, loading: workspaceLoading } = useWorkspace();
  const { data, loading, error, refetch } = useAsync(
    () => (current ? loadDashboard(current.id) : Promise.resolve({ projects: [], records: [], runs: [] })),
    [current?.id],
  );

  if (workspaceLoading || loading) return <LoadingState label="Loading your dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  if (data.projects.length === 0) {
    return (
      <EmptyState
        title="Make your first Discovery project"
        description="Create a project, point it at a website, and Discovery Platform will crawl, score and organize the leads it finds."
        action={<LinkButton to="/projects">Create a project</LinkButton>}
      />
    );
  }

  const recordsThisWeek = data.records.filter(r => Date.now() - new Date(r.created_at).getTime() < ONE_WEEK_MS).length;
  const recentRuns = [...data.runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 5);
  const recentRecords = [...data.records].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 5);
  const projectById = new Map(data.projects.map(p => [p.id, p]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">An overview of {current?.name}.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Projects" value={data.projects.length} />
        <StatCard label="Total records found" value={data.records.length} />
        <StatCard label="Records found this week" value={recordsThisWeek} />
        <StatCard label="Latest run status" value={recentRuns[0]?.status ?? '—'} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Recent Discovery runs</CardTitle></CardHeader>
          <CardContent className="p-0">
            {recentRuns.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-slate-500">No runs started yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentRuns.map(run => (
                  <li key={run.id} className="flex items-center justify-between px-6 py-3">
                    <div>
                      <Link to={`/projects/${run.project_id}`} className="text-sm font-medium text-slate-900 hover:underline">
                        {projectById.get(run.project_id)?.name ?? 'Project'}
                      </Link>
                      <p className="text-xs text-slate-400">{new Date(run.created_at).toLocaleString()}</p>
                    </div>
                    <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent records</CardTitle></CardHeader>
          <CardContent className="p-0">
            {recentRecords.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-slate-500">No records found yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recentRecords.map(record => {
                  const renderer = getDomainRenderer(record.domain);
                  return (
                    <li key={record.id} className="flex items-center justify-between px-6 py-3">
                      <Link to={`/records/${record.id}`} className="text-sm font-medium text-slate-900 hover:underline">
                        {record.display_name ?? 'Untitled record'}
                      </Link>
                      <span className="text-xs text-slate-400">{renderer.recordLabelPlural}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
