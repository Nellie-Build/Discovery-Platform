import { Link } from 'react-router-dom';
import { useWorkspace } from '../lib/workspace-context';
import { useAsync } from '../hooks/use-async';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, statusBadgeTone } from '../components/ui/badge';
import { LinkButton } from '../components/ui/link-button';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/states';
import { StatCard } from '../components/ui/stat-card';
import { ModuleCard } from '../components/ui/module-card';
import { Icon } from '../components/ui/icon';
import { getDomainRenderer } from '../domains/registry';
import { activityTime, dashboardRecordGroups, loadDashboard, runUrl } from '../lib/dashboard-data';
import { modulePresentation } from '../lib/module-presentation';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const date = (value: string | number) =>
  new Date(value).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
const statusLabels = {
  pending: 'In wachtrij',
  running: 'Bezig',
  succeeded: 'Geslaagd',
  partial: 'Gedeeltelijk geslaagd',
  failed: 'Mislukt',
};
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : '—');

export function DashboardPage() {
  const { current, loading: workspaceLoading, error: workspaceError } = useWorkspace();
  const { data, loading, error, refetch } = useAsync(
    () => (current ? loadDashboard(current.id) : Promise.resolve(null)),
    [current?.id],
  );
  if (workspaceError) return <ErrorState message={workspaceError} />;
  if (workspaceLoading) return <LoadingState label="Workspace laden…" />;
  if (!current)
    return (
      <EmptyState
        title="Nog geen workspace"
        description="Je account is nog niet gekoppeld aan een workspace. Vraag je beheerder om toegang."
      />
    );
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (loading || !data || data.workspaceId !== current.id) return <LoadingState label="Dashboard laden…" />;

  const groups = dashboardRecordGroups(data.records);
  const recentGroups = [...groups]
    .sort(
      (a, b) =>
        Math.max(...b.map((r) => Date.parse(r.created_at))) - Math.max(...a.map((r) => Date.parse(r.created_at))),
    )
    .slice(0, 5);
  const recentRuns = [...data.runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 5);
  const recentProjects = [...data.projects]
    .sort((a, b) => activityTime(b, data.runs, data.records) - activityTime(a, data.runs, data.records))
    .slice(0, 5);
  const projectById = new Map(data.projects.map((project) => [project.id, project]));
  const moduleName = (domain: string) =>
    data.modules.find((module) => module.module_id === domain)?.module_name ?? domain;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-brand-600">Workspace overzicht</p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Welkom bij Discovery Platform
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Van nieuwe signalen naar concrete kansen. Dit gebeurt er in{' '}
            <span className="font-medium text-slate-700">{current.name}</span>.
          </p>
        </div>
        {data.modules.length > 0 && (
          <LinkButton to="/projects?new=1">
            <Icon name="plus" className="h-4 w-4" />
            Nieuw project
          </LinkButton>
        )}
      </div>
      {data.unavailable.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Een deel van het overzicht is niet beschikbaar</p>
          <p className="mt-1">{data.unavailable.join('; ')}. De lijsten tonen alleen opgehaalde gegevens.</p>
          <button type="button" className="mt-2 font-medium underline" onClick={refetch}>
            Opnieuw proberen
          </button>
        </div>
      )}
      <section aria-label="Workspace statistieken" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard
          label="Actieve modules"
          value={data.modules.length}
          description="Beschikbaar in deze workspace"
          icon="module"
        />
        <StatCard
          label="Totaal projecten"
          value={data.projects.length}
          description="Binnen je beschikbare modules"
          icon="projects"
        />
        <StatCard
          label="Gevonden resultaten"
          value={data.unavailable.some((item) => item.startsWith('Resultaten')) ? '—' : groups.length}
          description="Gekoppelde aanbestedingen tellen als één"
          icon="records"
        />
        <StatCard
          label="Recente zoekruns"
          value={
            data.unavailable.some((item) => item.startsWith('Zoekruns'))
              ? '—'
              : data.runs.filter(
                  (run) => Date.parse(run.created_at) >= Date.now() - WEEK && Date.parse(run.created_at) <= Date.now(),
                ).length
          }
          description="Gestart in de afgelopen 7 dagen"
          icon="runs"
        />
      </section>
      <section aria-labelledby="modules-title">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 id="modules-title" className="text-lg font-semibold text-slate-900">
              Mijn modules
            </h2>
            <p className="mt-1 text-sm text-slate-500">Jouw vertrekpunt voor een nieuwe ontdekking.</p>
          </div>
          <Badge tone="info">{data.modules.length} actief</Badge>
        </div>
        {data.modules.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.modules.map((module) => (
              <ModuleCard
                key={module.module_id}
                module={module}
                projectCount={data.projects.filter((p) => p.domain === module.module_id).length}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nog geen modules beschikbaar"
            description="De beheerder kan modules beschikbaar maken via het workspacepakket of de moduletoegang."
          />
        )}
      </section>
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Mijn projecten</CardTitle>
            <Link to="/projects" className="text-xs font-medium text-brand-700 hover:underline">
              Alle projecten →
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            {recentProjects.length ? (
              <ul className="divide-y divide-slate-100">
                {recentProjects.map((project) => (
                  <li key={project.id}>
                    <Link
                      to={`/projects/${project.id}`}
                      className="flex items-center gap-3 px-6 py-4 hover:bg-slate-50"
                    >
                      <span className="shrink-0 rounded-lg bg-slate-100 p-2.5 text-slate-500">
                        <Icon name={modulePresentation(project.domain).icon} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-slate-800">{project.name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {moduleName(project.domain)} · Actief {date(activityTime(project, data.runs, data.records))}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-slate-500">
                        {data.unavailable.includes(`Resultaten van ${project.name}`)
                          ? '—'
                          : groups.filter((group) => group[0].project_id === project.id).length}{' '}
                        resultaten
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Ruimte voor je eerste project"
                description="Organiseer een zoekopdracht in een project. Je resultaten verschijnen hier vanzelf."
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Laatste ontdekkingen</CardTitle>
            <p className="mt-1 text-xs text-slate-500">De meest recent gevonden resultaten uit je modules.</p>
          </CardHeader>
          <CardContent className="p-0">
            {recentGroups.length ? (
              <ul className="divide-y divide-slate-100">
                {recentGroups.map((group) => {
                  const record = group[0];
                  const renderer = getDomainRenderer(record.domain);
                  const first = renderer.columns[0]?.key;
                  return (
                    <li key={record.id} className="px-6 py-4">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-brand-700">{moduleName(record.domain)}</span>
                        <span className="text-xs text-slate-500">
                          {date(Math.max(...group.map((r) => Date.parse(r.created_at))))}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-slate-800">
                        <Link to={`/records/${record.id}`} className="hover:text-brand-700 hover:underline">
                          {group.length > 1 && renderer.renderGroupCell && first
                            ? renderer.renderGroupCell(group, first)
                            : first
                              ? renderer.renderCell(record, first)
                              : (record.display_name ?? 'Resultaat')}
                        </Link>
                      </div>
                      {group.length > 1 && (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                          {group.map((member) => (
                            <Link
                              key={member.id}
                              to={`/records/${member.id}`}
                              className="text-xs text-brand-700 hover:underline"
                            >
                              {String(member.domain_data.sourceSystem ?? 'Bronrecord')} bekijken →
                            </Link>
                          ))}
                        </div>
                      )}
                      <p className="mt-1 text-xs text-slate-500">
                        {projectById.get(record.project_id)?.name}
                        {group.length > 1 ? ` · ${group.length} gekoppelde bronrecords` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                title="Je volgende ontdekking begint hier"
                description="Start een zoekrun vanuit een project. Beschikbare resultaten komen in dit overzicht."
              />
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Recente zoekruns</CardTitle>
            <p className="mt-1 text-xs text-slate-500">Volg de voortgang en open direct de bijbehorende resultaten.</p>
          </div>
          <Link to="/runs" className="text-xs font-medium text-brand-700 hover:underline">
            Alle zoekruns →
          </Link>
        </CardHeader>
        {recentRuns.length ? (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="bg-slate-50/80 text-xs text-slate-500">
                <tr>
                  {['Project / module', 'Gestart', 'Status', 'Nieuwe bronrecords', 'Bijgewerkte bronrecords', ''].map(
                    (label, index) => (
                      <th key={index} scope="col" className="px-6 py-3 font-medium">
                        {label || <span className="sr-only">Resultaten</span>}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <Link to={runUrl(run)} className="font-medium text-slate-800 hover:text-brand-700">
                        {projectById.get(run.project_id)?.name}
                      </Link>
                      <p className="mt-1 text-xs text-slate-500">
                        {moduleName(projectById.get(run.project_id)?.domain ?? '')}
                      </p>
                    </td>
                    <td className="px-6 py-4 text-slate-500">
                      {run.started_at
                        ? new Date(run.started_at).toLocaleString('nl-NL', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Nog niet gestart'}
                    </td>
                    <td className="px-6 py-4">
                      <Badge tone={statusBadgeTone(run.status)}>{statusLabels[run.status]}</Badge>
                    </td>
                    <td className="px-6 py-4 tabular-nums">{count(run.stats.recordsCreated)}</td>
                    <td className="px-6 py-4 tabular-nums">{count(run.stats.recordsUpdated)}</td>
                    <td className="px-6 py-4">
                      <Link
                        to={runUrl(run)}
                        aria-label={`Resultaten van ${projectById.get(run.project_id)?.name}, run ${run.id}`}
                        className="text-brand-700"
                      >
                        <Icon name="arrow" className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CardContent>
            <EmptyState
              title="Nog geen zoekruns"
              description="Je ziet hier de voortgang zodra je vanuit een project een zoekrun start."
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
