import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, type DiscoveryRun } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useAsync } from '../hooks/use-async';
import { usePolling } from '../hooks/use-polling';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input, Label, FieldError } from '../components/ui/input';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Badge, statusBadgeTone } from '../components/ui/badge';
import { LoadingState, ErrorState } from '../components/ui/states';
import { RunStatusCard } from '../components/run-status-card';
import { RecordsTable } from '../components/records-table';
import { getDomainRenderer } from '../domains/registry';

const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

type SearchMode = 'website' | 'branch';
const SEARCH_MODE_OPTIONS = [
  { value: 'website' as const, label: 'Website' },
  { value: 'branch' as const, label: 'Branche' },
];

export function StartDiscoveryForm({ projectId, onStarted }: { projectId: string; onStarted: (run: DiscoveryRun) => void }) {
  const [mode, setMode] = useState<SearchMode>('website');
  const [sourceUrl, setSourceUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [region, setRegion] = useState('');
  const [keywords, setKeywords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const run = mode === 'website'
        ? await api.runs.start(projectId, sourceUrl)
        : await api.runs.startBranchSearch(projectId, {
          branch,
          ...(region.trim() ? { region: region.trim() } : {}),
          ...(keywords.trim() ? { keywords: keywords.trim() } : {}),
        });
      onStarted(run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the Discovery run.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Start Discovery</CardTitle></CardHeader>
      <CardContent>
        <div className="mb-4">
          <p className="mb-1.5 block text-sm font-medium text-slate-700">Zoeken via</p>
          <SegmentedControl name="Zoeken via" options={SEARCH_MODE_OPTIONS} value={mode} onChange={setMode} />
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === 'website' ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Label htmlFor="source-url">Website URL</Label>
                <Input
                  id="source-url" type="url" required placeholder="https://company.com/careers"
                  value={sourceUrl} onChange={e => setSourceUrl(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start Discovery'}</Button>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="branch">Branche</Label>
                  <Input id="branch" required placeholder="Security" value={branch} onChange={e => setBranch(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="region">Regio</Label>
                  <Input id="region" placeholder="Nederland" value={region} onChange={e => setRegion(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="keywords">Extra trefwoorden</Label>
                  <Input id="keywords" placeholder="beveiliger security officer" value={keywords} onChange={e => setKeywords(e.target.value)} />
                </div>
              </div>
              <div>
                <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start Discovery'}</Button>
              </div>
            </>
          )}
        </form>
        <FieldError>{error}</FieldError>
      </CardContent>
    </Card>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { data: project, loading: projectLoading, error: projectError, refetch: refetchProject } = useAsync(
    () => api.projects.get(id!), [id],
  );
  const { data: records, loading: recordsLoading, refetch: refetchRecords } = useAsync(
    () => api.records.listByProject(id!), [id],
  );
  const { data: runs, loading: runsLoading, refetch: refetchRuns } = useAsync(
    () => api.runs.listByProject(id!), [id],
  );

  // Polling is deliberately used here even though today's API completes a run synchronously
  // before responding (see docs/architecture.md) — this keeps the UI correct without changes
  // if runs become asynchronous later, and costs nothing extra when they don't (the very first
  // poll already sees the terminal status).
  const { data: polledRun } = usePolling(() => api.runs.get(activeRunId!), {
    enabled: activeRunId !== null,
    // Identifies *which* run is being polled — without this, starting a second run while
    // `enabled` stays continuously true (see the effect below) would silently keep polling and
    // displaying the *first* run forever; usePolling only restarts on an enabled/key change.
    key: activeRunId,
    intervalMs: 1500,
    stopWhen: run => RUN_TERMINAL_STATUSES.has(run.status),
  });

  // Once the polled run reaches a terminal state, stop polling and refresh the record/run lists.
  // Depends on polledRun?.id, not just its status: every Discovery run today completes
  // synchronously, so two consecutive runs both resolve with the exact same status string
  // ('succeeded') on their very first poll — a status-only dependency would never re-fire for
  // the second run, leaving activeRunId (and so the status card) stuck on the first one.
  useEffect(() => {
    if (polledRun && activeRunId === polledRun.id && RUN_TERMINAL_STATUSES.has(polledRun.status)) {
      setActiveRunId(null);
      refetchRecords();
      refetchRuns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledRun?.id, polledRun?.status]);

  if (projectLoading) return <LoadingState label="Loading project…" />;
  if (projectError) return <ErrorState message={projectError} onRetry={refetchProject} />;
  if (!project) return null;

  const renderer = getDomainRenderer(project.domain);
  const latestRun = polledRun ?? runs?.[0] ?? null;

  function handleRunStarted(run: DiscoveryRun) {
    setActiveRunId(run.id);
    if (RUN_TERMINAL_STATUSES.has(run.status)) {
      refetchRecords();
      refetchRuns();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">{project.name}</h1>
            <Badge tone="info">{renderer.recordLabelPlural}</Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {records?.length ?? 0} record{records?.length === 1 ? '' : 's'} found · last run {latestRun ? new Date(latestRun.created_at).toLocaleDateString() : 'never'}
          </p>
        </div>
        <Link to="/projects" className="text-sm font-medium text-slate-500 hover:text-slate-700">← All projects</Link>
      </div>

      <StartDiscoveryForm projectId={project.id} onStarted={handleRunStarted} />

      {latestRun && <RunStatusCard run={latestRun} />}

      <div>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Recent records</h2>
        {recordsLoading ? <LoadingState label="Loading records…" /> : (
          <RecordsTable
            records={(records ?? []).slice(0, 10)}
            emptyTitle="No records yet"
            emptyDescription="Start a Discovery run above to find your first records."
          />
        )}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Run history</h2>
        {runsLoading ? <LoadingState label="Loading run history…" /> : (
          (runs ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No runs yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[480px] divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-slate-500">Started</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-500">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-500">New records</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(runs ?? []).map(run => (
                    <tr key={run.id}>
                      <td className="px-4 py-3 text-slate-700">{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</td>
                      <td className="px-4 py-3"><Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge></td>
                      <td className="px-4 py-3 text-slate-700">{typeof run.stats?.recordsCreated === 'number' ? run.stats.recordsCreated : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
