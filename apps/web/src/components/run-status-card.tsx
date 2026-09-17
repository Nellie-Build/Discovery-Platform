import type { DiscoveryRun } from '@discovery-platform/client';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, statusBadgeTone } from './ui/badge';

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const seconds = Math.max(0, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface SourceMeta {
  provider: string;
  site: string;
  status: 'ok' | 'empty' | 'partial' | 'error';
  candidates: number;
  error: string | null;
}

const SOURCE_LABELS: Record<string, string> = { indeed: 'Indeed', linkedin: 'LinkedIn', brave: 'Web Search' };

function sourceLabel(site: string): string {
  return SOURCE_LABELS[site] ?? site.charAt(0).toUpperCase() + site.slice(1);
}

function sourceStatusTone(status: string) {
  return status === 'ok' ? 'success' : status === 'empty' ? 'neutral' : status === 'partial' ? 'warning' : 'danger';
}

/** A compact per-provider breakdown for a branch-search run — every source a run *could* use is
 * shown, including one it never attempted at all (e.g. Web Search with no Brave key configured,
 * or excluded at a narrower search breadth) as "disabled", so it is always clear which sources
 * actually contributed and which didn't run at all. */
function SourcesSection({ sources }: { sources: SourceMeta[] }) {
  const hasWebSearch = sources.some(s => s.site === 'brave');
  const rows = hasWebSearch ? sources : [...sources, { provider: 'brave', site: 'brave', status: 'disabled' as const, candidates: 0, error: null }];
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Sources</h3>
      <ul className="flex flex-col gap-1.5">
        {rows.map(source => (
          <li key={`${source.provider}-${source.site}`} className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-700">{sourceLabel(source.site)}</span>
            <div className="flex items-center gap-2">
              {source.status !== 'disabled' && <span className="text-slate-500">{source.candidates} results</span>}
              <Badge tone={source.status === 'disabled' ? 'neutral' : sourceStatusTone(source.status)}>{source.status}</Badge>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
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
  const isBranchSearch = stats.searchMode === 'branch';

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
          {isBranchSearch && <Field label="Branche" value={typeof stats.branch === 'string' ? stats.branch : null} />}
          {isBranchSearch && <Field label="Regio" value={typeof stats.region === 'string' ? stats.region : null} />}
          {isBranchSearch && <Field label="Kandidaatbronnen" value={typeof stats.candidatesFound === 'number' ? stats.candidatesFound : null} />}
          <Field label="Pages visited" value={typeof stats.pagesVisited === 'number' ? stats.pagesVisited : null} />
          <Field label="Records found" value={typeof stats.factsFound === 'number' ? stats.factsFound : null} />
          <Field label="New records" value={typeof stats.recordsCreated === 'number' ? stats.recordsCreated : null} />
          <Field
            label="Duplicates"
            value={
              (stats.duplicatesWithinCrawl ?? stats.duplicatesAgainstExisting) !== undefined
                ? Number(stats.duplicatesWithinCrawl ?? 0) + Number(stats.duplicatesAgainstExisting ?? 0)
                : null
            }
          />
        </dl>
        {isBranchSearch && Array.isArray(stats.sources) && <SourcesSection sources={stats.sources as SourceMeta[]} />}
        {run.status === 'failed' && run.error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {run.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
