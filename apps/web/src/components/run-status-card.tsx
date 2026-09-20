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
  crawler_failed: 'Crawler kon niet starten',
};

function stopReasonLabel(stopReason: unknown): string | null {
  return typeof stopReason === 'string' ? STOP_REASON_LABELS[stopReason] ?? stopReason : null;
}

interface SourceQueryInfo { searchTerm: string; location: string | null; country: string | null; resultsWanted: number; timeoutMs: number | null }

interface SourceMeta {
  provider: string;
  site: string;
  status: string;
  durationMs?: number;
  errorType?: string;
  candidates: number;
  error: string | null;
  query?: SourceQueryInfo;
  requestedCandidates?: number;
  returnedCandidates?: number;
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

interface BreakdownBucket {
  discovered: number; notProcessed: number; noUsableData: number; rejectedByRelevance: number; relevant: number;
  rejectedByDate: number; duplicatesInRun: number; alreadyKnown: number; cutByTarget: number; newRecords: number; multiRecordExtra: number;
}
interface RunBreakdown extends BreakdownBucket { reseenRecords?: number; byProvider?: Record<string, BreakdownBucket> }

function isBreakdown(value: unknown): value is RunBreakdown {
  const v = value as Partial<RunBreakdown> | null;
  return Boolean(v) && typeof v === 'object' && typeof v?.discovered === 'number' && typeof v.newRecords === 'number';
}

/** What happened to every discovered candidate. The rows are mutually exclusive and add up to
 * "Kandidaten ontdekt" (plus, rarely, extra vacancies from a page that held several) — "Relevant"
 * is a subtotal of the rows below it, not an extra row. See apps/api's run-breakdown.ts. */
function BreakdownRows({ bucket, compact = false }: { bucket: BreakdownBucket; compact?: boolean }) {
  const rows: [string, number][] = [
    ['Niet verwerkt (doel of limiet eerder bereikt)', bucket.notProcessed],
    ['Geen bruikbare gegevens', bucket.noUsableData],
    ['Afgewezen op relevance', bucket.rejectedByRelevance],
    ['Afgewezen op datumfilter', bucket.rejectedByDate],
    ['Duplicaten binnen de run', bucket.duplicatesInRun],
    ['Al bekend in het project', bucket.alreadyKnown],
    ['Niet opgeslagen (boven het doel)', bucket.cutByTarget],
  ];
  return (
    <ul className={compact ? 'text-xs' : 'text-sm'}>
      <li className="flex justify-between font-medium"><span>Kandidaten ontdekt</span><span>{bucket.discovered}</span></li>
      {rows.map(([label, value]) => (
        <li key={label} className="flex justify-between text-slate-600"><span>− {label}</span><span>{value}</span></li>
      ))}
      <li className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900"><span>Nieuwe records</span><span>{bucket.newRecords}</span></li>
      {bucket.multiRecordExtra > 0 && <li className="flex justify-between text-slate-600"><span>+ extra vacatures van pagina's met meerdere vacatures</span><span>{bucket.multiRecordExtra}</span></li>}
      <li className="mt-2 flex justify-between text-xs italic text-slate-500"><span>Subtotaal: relevant na inhoudsfilter (staat al in de rijen hierboven)</span><span>{bucket.relevant}</span></li>
    </ul>
  );
}

function BreakdownSection({ breakdown }: { breakdown: RunBreakdown }) {
  const providers = Object.entries(breakdown.byProvider ?? {}).filter(([, bucket]) => bucket.discovered > 0 || bucket.multiRecordExtra > 0);
  return (
    <div className="mt-4" data-testid="run-breakdown">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Uitsplitsing kandidaten</h3>
      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
        <BreakdownRows bucket={breakdown} />
        <p className="mt-2 text-xs text-slate-500">Elke kandidaat valt in precies één categorie; de rijen tellen op tot het aantal ontdekte kandidaten.{breakdown.reseenRecords ? ` Daarnaast zijn ${breakdown.reseenRecords} bekende records opnieuw vastgelegd.` : ''}</p>
      </div>
      {providers.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium">Per bron</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {providers.map(([site, bucket]) => (
              <div key={site} className="rounded-lg border border-slate-100 p-3">
                <p className="mb-1 text-sm font-semibold">{sourceLabel(site)}</p>
                <BreakdownRows bucket={bucket} compact />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const FAILURE_LABELS: Record<string, string> = { timeout: 'timeout', rate_limited: 'rate limited', network: 'netwerkfout', provider_error: 'fout', source_unavailable: 'niet beschikbaar' };

/** One line for how complete the sources were: "Volledig", "Gedeeltelijk — LinkedIn timeout" or "Mislukt". */
function sourceStatusSummary(sources: SourceMeta[]): string | null {
  const used = sources.filter(source => !['not_configured', 'user_disabled', 'not_run'].includes(source.status));
  if (used.length === 0) return null;
  const failed = used.filter(source => ['partial', 'error', 'rate_limited', 'unavailable'].includes(source.status));
  if (failed.length === 0) return 'Volledig';
  const detail = failed.map(source => `${sourceLabel(source.site)} ${FAILURE_LABELS[source.errorType ?? ''] ?? (source.status === 'rate_limited' ? 'rate limited' : 'fout')}`).join(', ');
  return failed.length === used.length && !used.some(source => source.status === 'partial') ? `Mislukt — ${detail}` : `Gedeeltelijk — ${detail}`;
}

/** What every source was actually asked (search term, location, country, how many candidates were
 * requested and returned) — falls back to the older single search-term-per-source map. */
function ProviderQueries({ sources, legacyQueries }: { sources: SourceMeta[]; legacyQueries: Record<string, string> }) {
  const withQuery = sources.filter(source => source.query);
  if (withQuery.length === 0) {
    return <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">{Object.entries(legacyQueries).map(([site, query]) => <Field key={site} label={`Zoekopdracht ${sourceLabel(site)}`} value={query} />)}</dl>;
  }
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="provider-queries">
      {withQuery.map(source => (
        <div key={`${source.provider}-${source.site}`} className="rounded-lg border border-slate-100 p-3">
          <p className="mb-1 text-sm font-semibold">{sourceLabel(source.site)}</p>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Field label="Zoekterm" value={source.query?.searchTerm} />
            <Field label="Locatie" value={source.query?.location ?? 'Geen'} />
            <Field label="Land" value={source.query?.country ?? 'Geen'} />
            <Field label="Gevraagd / ontvangen" value={`${source.requestedCandidates ?? source.query?.resultsWanted ?? '—'} / ${source.returnedCandidates ?? source.candidates}`} />
            <Field label="Tijdslimiet" value={typeof source.query?.timeoutMs === 'number' ? formatSeconds(source.query.timeoutMs / 1000) : null} />
          </dl>
        </div>
      ))}
    </div>
  );
}

/** Why (and how far) a queue-driven crawl engine got — start-up phases, the failure it hit, and a
 * snapshot of the environment. Shown only when the run recorded any of it. */
function CrawlerDiagnostics({ stats }: { stats: Record<string, unknown> }) {
  const phases = Array.isArray(stats.crawlerPhases) ? stats.crawlerPhases as { phase: string; ms: number }[] : [];
  const failed = typeof stats.crawlerFailurePhase === 'string';
  if (!failed && phases.length === 0 && typeof stats.crawlError !== 'string') return null;
  const text = (key: string) => typeof stats[key] === 'string' || typeof stats[key] === 'number' ? String(stats[key]) : null;
  return (
    <div className="mt-4 rounded-lg border border-slate-100 p-3" data-testid="crawler-diagnostics">
      <p className="mb-2 text-sm font-semibold">Crawler-diagnose</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Laatste fase" value={text('crawlerPhase')} />
        <Field label="Foutfase" value={text('crawlerFailurePhase')} />
        <Field label="Fout" value={text('crawlerErrorName')} />
        <Field label="Foutcode" value={text('crawlerErrorCode')} />
        <Field label="Handler aangeroepen" value={text('crawlerRequestHandlerCalls')} />
      </dl>
      {text('crawlerErrorMessage') && <p className="mt-2 break-words text-sm text-red-800">{text('crawlerErrorMessage')}</p>}
      {text('crawlError') && !text('crawlerErrorMessage') && <p className="mt-2 break-words text-sm text-red-800">{text('crawlError')}</p>}
      {text('crawlerErrorCause') && <p className="mt-1 break-words text-xs text-slate-600">Oorzaak: {text('crawlerErrorCause')}</p>}
      {phases.length > 0 && <p className="mt-2 text-xs text-slate-600">Fases: {phases.map(item => `${item.phase} (${item.ms} ms)`).join(' → ')}</p>}
      {['crawlerQueue', 'crawlerBasicCrawler', 'crawlerRuntime'].filter(key => stats[key] && typeof stats[key] === 'object').map(key => (
        <p key={key} className="mt-1 break-words text-xs text-slate-600">{key.replace('crawler', '')}: {JSON.stringify(stats[key])}</p>
      ))}
      {text('crawlerErrorStack') && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">{text('crawlerErrorStack')}</pre>}
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
  const criteria = (stats.criteria ?? {}) as { mode?: string; branch?: string; keywords?: string; country?: string; region?: string; sourceUrl?: string; filters?: { postedWithinDays?: number; sources?: string[] }; runConfig?: { targetRecords?: number } };
  const duration = typeof stats.durationMs === 'number' ? formatSeconds(stats.durationMs / 1000) : formatDuration(run.started_at, run.completed_at);
  const isBranchSearch = stats.searchMode === 'branch';
  const compactBranch = isBranchSearch && isBreakdown(stats.breakdown);
  const sourceSummary = Array.isArray(stats.sources) ? sourceStatusSummary(stats.sources as SourceMeta[]) : null;
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
              {(criteria.country ?? (typeof stats.country === 'string' ? stats.country : null)) && <Field label="Land" value={criteria.country ?? String(stats.country)} />}
              <Field label={criteria.country ? 'Regio / plaats' : 'Regio'} value={criteria.region ?? (typeof stats.region === 'string' ? stats.region : 'Niet opgegeven')} />
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
            {!compactBranch && <p>Kandidaten: {Number(stats.candidatesDiscovered ?? 0)} · Relevant: {Number(stats.candidatesRelevant ?? 0)} · Afgewezen: {Number(stats.candidatesRejectedByRelevance ?? 0)} · Geaccepteerd: {Number(stats.recordsAccepted ?? 0)}</p>}
          </div>
        )}
        {compactBranch && isBreakdown(stats.breakdown) && <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3" data-testid="run-core-figures">
            <Field label="Doel" value={typeof stats.targetRecords === 'number' ? stats.targetRecords : null} />
            <Field label="Gevonden" value={typeof stats.recordsAccepted === 'number' ? stats.recordsAccepted : null} />
            <Field label="Nieuw" value={stats.breakdown.newRecords} />
            <Field label="Duur" value={duration} />
            <Field label="Resultaat" value={stopReasonLabel(stats.stopReason)} />
            <Field label="Bronstatus" value={sourceSummary} />
          </dl>
          <BreakdownSection breakdown={stats.breakdown} />
        </>}
        {!compactBranch && (!stats.budgetSource || isBranchSearch) && <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
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
        {!compactBranch && <div className="mt-4 border-t border-slate-100 pt-4">
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
        </div>}
        {compactBranch && (
          <details className="mt-4 border-t border-slate-100 pt-4" data-testid="run-technical-details">
            <summary className="cursor-pointer text-sm font-medium">Technische details</summary>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Gestart" value={run.started_at ? new Date(run.started_at).toLocaleString() : null} />
              <Field label="Kandidaten verwerkt" value={typeof stats.candidatesProcessed === 'number' ? stats.candidatesProcessed : null} />
              <Field label="Records gevonden (voor ontdubbeling)" value={typeof stats.factsFound === 'number' ? stats.factsFound : null} />
              <Field label="Duplicaten (run + project)" value={duplicates} />
              <Field label="Budget" value={stats.budgetSource === 'adaptive' ? 'Automatisch' : stats.budgetSource === 'advanced' ? 'Geavanceerd' : null} />
              <Field label="Max kandidaten" value={typeof stats.maxCandidates === 'number' ? stats.maxCandidates : null} />
              <Field label="Max duur (ms)" value={typeof stats.maxDurationMs === 'number' ? stats.maxDurationMs : null} />
            </dl>
            <ProviderQueries sources={Array.isArray(stats.sources) ? stats.sources as SourceMeta[] : []} legacyQueries={(stats.providerQueries ?? {}) as Record<string, string>} />
          </details>
        )}
        {typeof stats.budgetSource === 'string' && !compactBranch && (
          <details className="mt-4 border-t border-slate-100 pt-4">
            <summary className="cursor-pointer text-sm font-medium">Technische details</summary>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Budget" value={stats.budgetSource === 'adaptive' ? 'Automatisch' : 'Geavanceerd'} />
              {(['maxPages', 'maxCandidates', 'maxDurationMs', 'pagesVisited', 'pagesAccepted', 'pagesRejected', 'recordsCreated', 'uniqueUrlsDiscovered', 'sitemapUrlsFound', 'sitemapCandidatesAccepted', 'sitemapCandidatesRejected', 'listingUrlsFound', 'highConfidenceCandidates', 'mediumConfidenceCandidates', 'lowConfidenceCandidates', 'candidatesRemaining', 'knownCandidates', 'newCandidates', 'unchangedCandidates'] as const).map(key => (
                <Field key={key} label={key} value={typeof stats[key] === 'number' ? stats[key] : null} />
              ))}
              {typeof stats.crawlerEngine === 'string' && <Field label="Crawler" value={stats.crawlerEngine} />}
              {(['requestsQueued', 'requestsStarted', 'requestsSucceeded', 'requestsFailed', 'requestsRetried', 'maxConcurrencyUsed', 'queueRemaining'] as const)
                .filter(key => typeof stats[key] === 'number').map(key => <Field key={key} label={key} value={stats[key] as number} />)}
            </dl>
            <CrawlerDiagnostics stats={stats} />
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
