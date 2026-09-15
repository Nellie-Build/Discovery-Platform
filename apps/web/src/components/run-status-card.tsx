import type { DiscoveryRun } from '@discovery-platform/client';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, statusBadgeTone } from './ui/badge';

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const seconds = Math.max(0, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value ?? <span className="text-slate-400">—</span>}</dd>
    </div>
  );
}

/** The run detail every screen that shows a run (project detail, run history) renders
 * identically — status, timing, and the crawler's own stats (pages visited, records found/new,
 * duplicates), or the error message when it failed. */
export function RunStatusCard({ run }: { run: DiscoveryRun }) {
  const stats = run.stats ?? {};
  const duration = formatDuration(run.started_at, run.completed_at);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Discovery run</CardTitle>
        <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Started" value={run.started_at ? new Date(run.started_at).toLocaleString() : null} />
          <Field label="Duration" value={duration} />
          <Field label="Pages visited" value={typeof stats.pagesVisited === 'number' ? stats.pagesVisited : null} />
          <Field label="Records found" value={typeof stats.factsFound === 'number' ? stats.factsFound : null} />
          <Field label="New records" value={typeof run.recordsCreated === 'number' ? run.recordsCreated : null} />
          <Field
            label="Duplicates"
            value={
              (stats.duplicatesWithinCrawl ?? stats.duplicatesAgainstExisting) !== undefined
                ? Number(stats.duplicatesWithinCrawl ?? 0) + Number(stats.duplicatesAgainstExisting ?? 0)
                : null
            }
          />
        </dl>
        {run.status === 'failed' && run.error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {run.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
