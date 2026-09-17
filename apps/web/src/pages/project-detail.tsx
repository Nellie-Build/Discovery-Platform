import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, type DiscoveryRun, type DiscoveryRunConfig, type VacancySearchFilters } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useAsync } from '../hooks/use-async';
import { usePolling } from '../hooks/use-polling';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input, Label, FieldError } from '../components/ui/input';
import { SegmentedControl, type SegmentedControlOption } from '../components/ui/segmented-control';
import { Badge, statusBadgeTone } from '../components/ui/badge';
import { Dialog } from '../components/ui/dialog';
import { LoadingState, ErrorState } from '../components/ui/states';
import { RunStatusCard } from '../components/run-status-card';
import { RecordsTable } from '../components/records-table';
import { getDomainRenderer } from '../domains/registry';

const DELETE_PROJECT_CONFIRM_TEXT =
  'Project verwijderen? Dit project en de bijbehorende gegevens worden niet meer getoond. ' +
  'Deze actie kan later door een beheerder worden hersteld.';

function DeleteProjectButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setDeleting(true);
    setError(null);
    try {
      await api.projects.delete(projectId);
      navigate('/projects');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Delete project</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete “${projectName}”?`}>
        <p className="text-sm text-slate-600">{DELETE_PROJECT_CONFIRM_TEXT}</p>
        <FieldError>{error}</FieldError>
        <div className="mt-4 flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" onClick={handleConfirm} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete project'}</Button>
        </div>
      </Dialog>
    </>
  );
}

const RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

/**
 * True when `candidate` is allowed to replace `current` as "the run this page shows" — never an
 * older run replacing a newer one, regardless of which one's own async response (start-run or
 * poll) happens to resolve last. Compares `created_at`, the moment the run was actually created
 * server-side, not response-arrival order: a slow response for a run started *before* another one
 * must never overwrite what that newer run already put on screen (see handleRunStarted below).
 */
export function isNewerRun(candidate: DiscoveryRun, current: DiscoveryRun | null): boolean {
  if (!current) return true;
  return new Date(candidate.created_at).getTime() >= new Date(current.created_at).getTime();
}

type SearchMode = 'website' | 'branch';
const SEARCH_MODE_OPTIONS = [
  { value: 'website' as const, label: 'Website' },
  { value: 'branch' as const, label: 'Branche' },
];

// Generic search-breadth tiers — never a hardcoded provider count in this UI. What each tier
// actually does (which providers run, which caps apply) is entirely the domain module's own
// decision server-side (see domains/vacancies/src/sources/registry.ts's SEARCH_BREADTH_LIMITS);
// this form only ever passes the tier's id through. 'advanced' additionally reveals the raw
// DiscoveryRunConfig numeric fields below — see AdvancedSettings.
type SearchModeOption = 'focused' | 'standard' | 'broad' | 'advanced';
const ZOEKMODUS_OPTIONS: SegmentedControlOption<SearchModeOption>[] = [
  { value: 'focused', label: 'Focused' },
  { value: 'standard', label: 'Standard' },
  { value: 'broad', label: 'Broad' },
  { value: 'advanced', label: 'Geavanceerd' },
];

type TargetPreset = '10' | '25' | '50' | '100' | '250' | '500' | 'custom';
const TARGET_PRESET_OPTIONS: SegmentedControlOption<TargetPreset>[] = [
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
  { value: '250', label: '250' },
  { value: '500', label: '500' },
  { value: 'custom', label: 'Aangepast' },
];

type PostedWithinOption = 'all' | 'today' | '7' | '14' | '30';
const POSTED_WITHIN_OPTIONS: SegmentedControlOption<PostedWithinOption>[] = [
  { value: 'all', label: 'Alles' },
  { value: 'today', label: 'Vandaag' },
  { value: '7', label: 'Laatste 7 dagen' },
  { value: '14', label: 'Laatste 14 dagen' },
  { value: '30', label: 'Laatste 30 dagen' },
];
const POSTED_WITHIN_DAYS: Record<PostedWithinOption, number | undefined> = {
  all: undefined, today: 1, '7': 7, '14': 14, '30': 30,
};

// Every vacancy source the branch-mode adapter knows how to select (see
// apps/api/src/domains/vacancies-adapter.ts's own VACANCY_SOURCE_IDS) — kept in one place so
// "everything checked" can be compared against the full set below.
const VACANCY_SOURCE_OPTIONS: Array<{ id: 'indeed' | 'linkedin' | 'web_search'; label: string }> = [
  { id: 'indeed', label: 'Indeed' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'web_search', label: 'Web Search (indien beschikbaar)' },
];
const ALL_VACANCY_SOURCE_IDS = VACANCY_SOURCE_OPTIONS.map(s => s.id);

function Toggle({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button" id={id} role="switch" aria-checked={checked} aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
      </button>
      <label htmlFor={id} className="text-sm text-slate-700">{label}</label>
    </div>
  );
}

/** targetRecords + maxPages/maxCandidates/maxDuration/maxEnrichments, only shown once the user
 * picks Zoekmodus "Geavanceerd" — every field maps 1:1 to DiscoveryRunConfig (see
 * apps/api/src/discovery-run-config.ts). Left blank, a field is simply omitted from the request
 * and the server fills in (and, regardless, clamps) its own default — the frontend is never the
 * security boundary, the ABSOLUTE_MAX_* server constants are. */
function AdvancedSettings({ maxPages, setMaxPages, maxCandidates, setMaxCandidates, maxDurationSec, setMaxDurationSec, maxEnrichments, setMaxEnrichments }: {
  maxPages: string; setMaxPages: (v: string) => void;
  maxCandidates: string; setMaxCandidates: (v: string) => void;
  maxDurationSec: string; setMaxDurationSec: (v: string) => void;
  maxEnrichments: string; setMaxEnrichments: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm sm:grid-cols-4">
      <div>
        <Label htmlFor="max-pages">Max pagina's</Label>
        <Input id="max-pages" type="number" min={1} placeholder="server default" value={maxPages} onChange={e => setMaxPages(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="max-candidates">Max kandidaten</Label>
        <Input id="max-candidates" type="number" min={1} placeholder="server default" value={maxCandidates} onChange={e => setMaxCandidates(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="max-duration">Max duur (sec)</Label>
        <Input id="max-duration" type="number" min={1} placeholder="server default" value={maxDurationSec} onChange={e => setMaxDurationSec(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="max-enrichments">Max verrijkingen</Label>
        <Input id="max-enrichments" type="number" min={0} placeholder="server default" value={maxEnrichments} onChange={e => setMaxEnrichments(e.target.value)} />
      </div>
    </div>
  );
}

export function StartDiscoveryForm({ projectId, onStarted }: { projectId: string; onStarted: (run: DiscoveryRun) => void }) {
  const [mode, setMode] = useState<SearchMode>('website');
  const [sourceUrl, setSourceUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [region, setRegion] = useState('');
  const [keywords, setKeywords] = useState('');
  const [searchMode, setSearchMode] = useState<SearchModeOption>('standard');

  // Zoekinstellingen — shared by both Website and Branche mode (see spec section 4).
  const [targetPreset, setTargetPreset] = useState<TargetPreset>('50');
  const [targetCustom, setTargetCustom] = useState('50');
  const [postedWithin, setPostedWithin] = useState<PostedWithinOption>('all');
  const [onlyNewRecords, setOnlyNewRecords] = useState(true);
  const [sources, setSources] = useState<Set<string>>(new Set(ALL_VACANCY_SOURCE_IDS));
  const [maxPages, setMaxPages] = useState('');
  const [maxCandidates, setMaxCandidates] = useState('');
  const [maxDurationSec, setMaxDurationSec] = useState('');
  const [maxEnrichments, setMaxEnrichments] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleSource(id: string, checked: boolean) {
    setSources(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  function buildRunConfig(): DiscoveryRunConfig {
    const targetRecords = targetPreset === 'custom' ? Number(targetCustom) : Number(targetPreset);
    const config: DiscoveryRunConfig = { targetRecords, searchBreadth: searchMode, onlyNewRecords };
    if (searchMode === 'advanced') {
      if (maxPages.trim()) config.maxPages = Number(maxPages);
      if (maxCandidates.trim()) config.maxCandidates = Number(maxCandidates);
      if (maxDurationSec.trim()) config.maxDurationMs = Number(maxDurationSec) * 1000;
      if (maxEnrichments.trim()) config.maxEnrichments = Number(maxEnrichments);
    }
    return config;
  }

  function buildFilters(): VacancySearchFilters {
    const filters: VacancySearchFilters = {};
    const postedWithinDays = POSTED_WITHIN_DAYS[postedWithin];
    if (postedWithinDays) filters.postedWithinDays = postedWithinDays;
    // Only sent when the user actually changed it from "everything checked" — leaving every
    // source checked must behave exactly like never specifying `sources` at all (the breadth
    // tier's own default), so an unconfigured Web Search never surfaces a "requested but not
    // configured" notice for a user who never singled it out (see vacancies-adapter.ts's own
    // `webSearchExplicitlyRequested`).
    if (mode === 'branch' && sources.size !== ALL_VACANCY_SOURCE_IDS.length) filters.sources = [...sources];
    return filters;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const runConfig = buildRunConfig();
      const filters = buildFilters();
      const run = mode === 'website'
        ? await api.runs.start(projectId, sourceUrl, { runConfig, filters })
        : await api.runs.startBranchSearch(projectId, {
          branch,
          ...(region.trim() ? { region: region.trim() } : {}),
          ...(keywords.trim() ? { keywords: keywords.trim() } : {}),
          runConfig, filters,
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {mode === 'website' ? (
            <div className="flex-1">
              <Label htmlFor="source-url">Website URL</Label>
              <Input
                id="source-url" type="url" required placeholder="https://company.com/careers"
                value={sourceUrl} onChange={e => setSourceUrl(e.target.value)}
              />
            </div>
          ) : (
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
          )}

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Zoekinstellingen</h3>
            <div className="flex flex-col gap-3">
              <div>
                <p className="mb-1.5 block text-sm font-medium text-slate-700">Gewenste resultaten</p>
                <SegmentedControl name="Gewenste resultaten" options={TARGET_PRESET_OPTIONS} value={targetPreset} onChange={setTargetPreset} />
                {targetPreset === 'custom' && (
                  <Input
                    id="target-custom" type="number" min={1} className="mt-2 max-w-[10rem]" aria-label="Aangepast aantal resultaten"
                    value={targetCustom} onChange={e => setTargetCustom(e.target.value)}
                  />
                )}
              </div>

              <div>
                <p className="mb-1.5 block text-sm font-medium text-slate-700">Geplaatst in</p>
                <SegmentedControl name="Geplaatst in" options={POSTED_WITHIN_OPTIONS} value={postedWithin} onChange={setPostedWithin} />
              </div>

              <Toggle id="only-new-records" checked={onlyNewRecords} onChange={setOnlyNewRecords} label="Alleen nieuwe resultaten" />

              <div>
                <p className="mb-1.5 block text-sm font-medium text-slate-700">Bronnen</p>
                {mode === 'branch' ? (
                  <div className="flex flex-wrap gap-4">
                    {VACANCY_SOURCE_OPTIONS.map(source => (
                      <label key={source.id} className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox" checked={sources.has(source.id)}
                          onChange={e => toggleSource(source.id, e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        />
                        {source.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">Website crawl</p>
                )}
              </div>

              <div>
                <p className="mb-1.5 block text-sm font-medium text-slate-700">Zoekmodus</p>
                <SegmentedControl name="Zoekmodus" options={ZOEKMODUS_OPTIONS} value={searchMode} onChange={setSearchMode} />
                {searchMode === 'advanced' && (
                  <div className="mt-3">
                    <AdvancedSettings
                      maxPages={maxPages} setMaxPages={setMaxPages}
                      maxCandidates={maxCandidates} setMaxCandidates={setMaxCandidates}
                      maxDurationSec={maxDurationSec} setMaxDurationSec={setMaxDurationSec}
                      maxEnrichments={maxEnrichments} setMaxEnrichments={setMaxEnrichments}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          <div>
            <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start Discovery'}</Button>
          </div>
        </form>
        <FieldError>{error}</FieldError>
      </CardContent>
    </Card>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // The newest run this page has actually shown so far, from either handleRunStarted or a poll
  // result — the reference point isNewerRun compares an incoming response against, so a
  // delayed/out-of-order response tied to an older run can never win a race against a newer one.
  const latestKnownRunRef = useRef<DiscoveryRun | null>(null);

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
    if (!polledRun || activeRunId !== polledRun.id) return;
    if (isNewerRun(polledRun, latestKnownRunRef.current)) latestKnownRunRef.current = polledRun;
    if (RUN_TERMINAL_STATUSES.has(polledRun.status)) {
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

  // Guards against a start-run response arriving out of order: if the user starts run A, then
  // (before A's own response comes back) starts run B, and B's response happens to resolve
  // first, A's later, stale response must never re-activate A after B already took over. See
  // isNewerRun above — an older run's response is simply ignored, never displayed.
  function handleRunStarted(run: DiscoveryRun) {
    if (!isNewerRun(run, latestKnownRunRef.current)) return;
    latestKnownRunRef.current = run;
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
        <div className="flex items-center gap-4">
          <Link to="/projects" className="text-sm font-medium text-slate-500 hover:text-slate-700">← All projects</Link>
          <DeleteProjectButton projectId={project.id} projectName={project.name} />
        </div>
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
