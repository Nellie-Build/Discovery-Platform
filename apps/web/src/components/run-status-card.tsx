import type { DiscoveryRun } from '@discovery-platform/client';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge, statusBadgeTone } from './ui/badge';

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  return formatSeconds((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);
}

/** Dutch labels for discovery-core's/the vacancies adapter's own `stopReason` codes (see
 * packages/discovery-core's CrawlStopReason and vacancies-adapter.ts's own branch-mode
 * stopReason) — the one place a stop reason code is translated for display. */
const STOP_REASON_LABELS: Record<string, string> = {
  target_reached: 'Doel bereikt',
  no_more_candidates: 'Geen kandidaten meer',
  page_limit: 'Maximale paginalimiet bereikt',
  candidate_limit: 'Maximale kandidatenlimiet bereikt',
  time_limit: 'Maximale tijdslimiet bereikt',
  rate_limited: 'Snelheidslimiet van de bron bereikt',
  robots_blocked: 'Geblokkeerd door robots.txt',
  provider_exhausted: 'Bron uitgeput',
  no_results: 'Geen resultaten bij de beschikbare bronnen',
  all_sources_failed: 'Alle bronnen mislukt',
  source_rate_limited: 'Bron tijdelijk begrensd',
  source_unavailable: 'Geen volledige brontoegang',
};

function stopReasonLabel(stopReason: unknown): string | null {
  return typeof stopReason === 'string' ? STOP_REASON_LABELS[stopReason] ?? stopReason : null;
}

interface SourceMeta {
  provider: string;
  site: string;
  status: string;
  durationMs?: number;
  errorType?: string;
  candidates: number;
  error: string | null;
}

const SOURCE_LABELS: Record<string, string> = { indeed: 'Indeed', linkedin: 'LinkedIn', brave: 'Web Search' };

function sourceLabel(site: string): string {
  return SOURCE_LABELS[site] ?? site.charAt(0).toUpperCase() + site.slice(1);
}

function sourceStatusTone(status: string) {
  return status === 'ok' ? 'success' : ['empty', 'not_configured', 'user_disabled', 'not_run'].includes(status) ? 'neutral' : status === 'partial' ? 'warning' : 'danger';
}
const SOURCE_STATUS_LABELS: Record<string, string> = { not_configured: 'Niet geconfigureerd', user_disabled: 'Uitgeschakeld', not_run: 'Niet uitgevoerd', rate_limited: 'Rate limited', unavailable: 'Niet beschikbaar' };

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
          <li key={`${source.provider}-${source.site}`} className="flex items-center justify-between rounded-lg bg-slate-50 px-3.5 py-2.5 text-sm border border-slate-100 hover:bg-slate-100 hover:shadow-sm transition-all duration-200">
            <span className="font-medium text-slate-700">{sourceLabel(source.site)}</span>
            <div className="flex items-center gap-2">
              {source.status !== 'disabled' && <span className="text-slate-500">{source.candidates} results</span>}
              {typeof source.durationMs === 'number' && <span>{formatSeconds(source.durationMs / 1000)}</span>}
              {source.errorType && <span>{source.errorType}</span>}
              <Badge tone={source.status === 'disabled' ? 'neutral' : sourceStatusTone(source.status)}>{SOURCE_STATUS_LABELS[source.status] ?? source.status}</Badge>
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
  const criteria = (stats.criteria ?? {}) as { mode?: string; branch?: string; keywords?: string; region?: string; sourceUrl?: string; filters?: { postedWithinDays?: number; sources?: string[] }; runConfig?: { targetRecords?: number } };
  const duration = typeof stats.durationMs === 'number' ? formatSeconds(stats.durationMs / 1000) : formatDuration(run.started_at, run.completed_at);
  const isBranchSearch = stats.searchMode === 'branch';
  const duplicates = typeof stats.duplicates === 'number'
    ? stats.duplicates
    : (stats.duplicatesWithinCrawl ?? stats.duplicatesAgainstExisting) !== undefined
      ? Number(stats.duplicatesWithinCrawl ?? 0) + Number(stats.duplicatesAgainstExisting ?? 0)
      : null;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Discovery run</CardTitle>
        <Badge tone={statusBadgeTone(run.status)}>{run.status}</Badge>
      </CardHeader>
      <CardContent>
        <div className="mb-4 rounded-lg bg-slate-50 p-3">
          <p className="mb-2 text-sm font-semibold">Zoekcriteria van deze run</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {isBranchSearch || criteria.mode === 'branch' ? <>
              <Field label="Branche" value={criteria.branch ?? (typeof stats.branch === 'string' ? stats.branch : null)} />
              <Field label="Keywords" value={criteria.keywords ?? (typeof stats.keywords === 'string' ? stats.keywords : 'Geen')} />
              <Field label="Regio" value={criteria.region ?? (typeof stats.region === 'string' ? stats.region : 'Niet opgegeven')} />
              <Field label="Gekozen bronnen" value={criteria.filters?.sources?.join(', ') || (criteria.filters?.sources ? 'Geen' : 'Volgens zoekmodus')} />
            </> : <Field label="Website URL" value={criteria.sourceUrl ?? 'Niet vastgelegd voor deze oudere run'} />}
            <Field label="Date filter" value={criteria.filters?.postedWithinDays ? `Laatste ${criteria.filters.postedWithinDays} dagen` : stats.criteria ? 'Alle datums' : 'Niet vastgelegd'} />
            <Field label="Target" value={criteria.runConfig?.targetRecords ?? (typeof stats.targetRecords === 'number' ? stats.targetRecords : null)} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">De projectnaam is een label; deze criteria bepalen de zoekopdracht.</p>
        </div>
        {typeof stats.sourcesSucceeded === 'number' && typeof stats.sourcesRequested === 'number' && (
          <div className="mb-4 text-sm">
            {stats.sourcesSucceeded < 3 && <p className="font-medium text-amber-700">Beperkte brondekking</p>}
            <p>{stats.sourcesSucceeded} van 3 bronnen leverden een bruikbaar antwoord. Gevraagd: {stats.sourcesRequested}; beschikbaar: {Number(stats.sourcesAvailable ?? 0)}; mislukt: {Number(stats.sourcesFailed ?? 0)}.</p>
            <p>Het aantal gevonden resultaten beschrijft alleen de beschikbare bronnen.</p>
            <p>Kandidaten: {Number(stats.candidatesDiscovered ?? 0)} · Relevant: {Number(stats.candidatesRelevant ?? 0)} · Afgewezen: {Number(stats.candidatesRejectedByRelevance ?? 0)} · Geaccepteerd: {Number(stats.recordsAccepted ?? 0)}</p>
          </div>
        )}
        {(!stats.budgetSource || isBranchSearch) && <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Started" value={run.started_at ? new Date(run.started_at).toLocaleString() : null} />
          <Field label="Duur" value={duration} />
          {isBranchSearch && <Field label="Kandidaatbronnen" value={typeof stats.candidatesFound === 'number' ? stats.candidatesFound : null} />}
          <Field label="Pages visited" value={typeof stats.pagesVisited === 'number' ? stats.pagesVisited : null} />
          <Field label="Records found" value={typeof stats.factsFound === 'number' ? stats.factsFound : null} />
          <Field label="New records" value={typeof stats.recordsCreated === 'number' ? stats.recordsCreated : null} />
          <Field label="Duplicates" value={duplicates} />
        </dl>}
        {/* The run's own configured target and how it actually progressed — see
            DiscoveryRunConfig/`stats.stopReason`. Shown separately from the crawl-detail fields
            above so both "target reached" and "target not reached" read clearly at a glance. */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Voortgang</h3>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Doel" value={typeof stats.targetRecords === 'number' ? stats.targetRecords : null} />
            <Field label="Gevonden" value={typeof stats.recordsAccepted === 'number' ? stats.recordsAccepted : null} />
            <Field label="URLs ontdekt" value={typeof stats.urlsDiscovered === 'number' ? stats.urlsDiscovered : null} />
            <Field label="Kandidaten" value={typeof stats.candidateUrlsFound === 'number' ? stats.candidateUrlsFound : typeof stats.candidatesDiscovered === 'number' ? stats.candidatesDiscovered : null} />
            <Field label="Verwerkt" value={typeof stats.candidatesProcessed === 'number' ? stats.candidatesProcessed : null} />
            {typeof stats.budgetSource === 'string' && !isBranchSearch && <Field label="Duplicates" value={duplicates} />}
            {typeof stats.budgetSource === 'string' && !isBranchSearch && <Field label="Duur" value={duration} />}
            <Field label="Gestopt omdat" value={stopReasonLabel(stats.stopReason)} />
          </dl>
        </div>
        {typeof stats.budgetSource === 'string' && (
          <details className="mt-4 border-t border-slate-100 pt-4">
            <summary className="cursor-pointer text-sm font-medium">Technische details</summary>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Budget" value={stats.budgetSource === 'adaptive' ? 'Automatisch' : 'Geavanceerd'} />
              {(['maxPages', 'maxCandidates', 'maxDurationMs', 'pagesVisited', 'pagesAccepted', 'pagesRejected', 'recordsCreated', 'uniqueUrlsDiscovered', 'sitemapUrlsFound', 'sitemapCandidatesAccepted', 'sitemapCandidatesRejected', 'listingUrlsFound', 'highConfidenceCandidates', 'mediumConfidenceCandidates', 'lowConfidenceCandidates', 'candidatesRemaining', 'knownCandidates', 'newCandidates', 'unchangedCandidates'] as const).map(key => (
                <Field key={key} label={key} value={typeof stats[key] === 'number' ? stats[key] : null} />
              ))}
            </dl>
          </details>
        )}
        {isBranchSearch && Array.isArray(stats.sources) && <SourcesSection sources={stats.sources as SourceMeta[]} />}
        {run.status === 'failed' && run.error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-sm">
            {run.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
