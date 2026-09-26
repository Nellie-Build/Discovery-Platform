import { useEffect, useRef, useState } from 'react';
import { ApiError, type DiscoveryJob, type DiscoveryJobLimits, type DiscoveryRun } from '@discovery-platform/client';
import { api } from '../../lib/api';
import { useAsync } from '../../hooks/use-async';
import { usePolling } from '../../hooks/use-polling';
import { Button } from '../../components/ui/button';
import { Input, Label, FieldError } from '../../components/ui/input';
import { Badge, type BadgeTone } from '../../components/ui/badge';

/**
 * Extended processing of a companies search: the user sets hard limits up front, the search then runs in the background
 * in batches (the first one searches, every next one researches the candidates left, without searching again). Progress
 * is polled; every batch that finishes is handed to the project page like a run, so its results show while the job goes
 * on. Pause, resume and stop are explicit user actions; nothing here starts a job by itself.
 */
export interface JobLimitFields { maxCandidates: string; batchSize: string; pagesPerCompany: string; maxSearchQueries: string }
export const defaultJobLimits = (): JobLimitFields => ({ maxCandidates: '30', batchSize: '5', pagesPerCompany: '5', maxSearchQueries: '6' });
const CEILINGS: Record<keyof JobLimitFields, number> = { maxCandidates: 100, batchSize: 10, pagesPerCompany: 12, maxSearchQueries: 12 };
const LIMIT_LABELS: Record<keyof JobLimitFields, string> = {
  maxCandidates: 'Maximaal aantal kandidaat-bedrijven (totaal)', batchSize: 'Bedrijven per batch', pagesPerCompany: 'Pagina’s per bedrijf', maxSearchQueries: 'Maximaal aantal zoekopdrachten',
};

/** The limits for the API, or the first one to fix. */
export function buildJobLimits(fields: JobLimitFields): { limits: DiscoveryJobLimits } | { error: string } {
  const limits = {} as DiscoveryJobLimits;
  for (const key of Object.keys(CEILINGS) as Array<keyof JobLimitFields>) {
    const value = Number(fields[key]);
    if (!Number.isInteger(value) || value < 1 || value > CEILINGS[key]) return { error: `${LIMIT_LABELS[key]}: een getal van 1 tot ${CEILINGS[key]}.` };
    limits[key] = value;
  }
  return { limits };
}

export function JobLimitsFields({ fields, onChange }: { fields: JobLimitFields; onChange: (fields: JobLimitFields) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Limieten uitgebreide verwerking" role="group">
      {(Object.keys(CEILINGS) as Array<keyof JobLimitFields>).map(key => (
        <div key={key}>
          <Label htmlFor={`job-${key}`}>{LIMIT_LABELS[key]}</Label>
          <Input id={`job-${key}`} type="number" min={1} max={CEILINGS[key]} value={fields[key]} onChange={e => onChange({ ...fields, [key]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

const ACTIVE = new Set<DiscoveryJob['status']>(['queued', 'running', 'paused', 'stopping']);
const STATUS_TEXT: Record<DiscoveryJob['status'], [string, BadgeTone]> = {
  queued: ['In de wachtrij', 'info'], running: ['Bezig', 'info'], paused: ['Gepauzeerd', 'warning'], stopping: ['Wordt gestopt na deze batch', 'warning'],
  stopped: ['Gestopt', 'neutral'], completed: ['Afgerond', 'success'], failed: ['Mislukt', 'danger'],
};

/** Progress of the project's latest job, with its controls. Hands every batch that finishes to `onBatchFinished`. */
export function CompanyJobProgress({ projectId, refreshKey, onBatchFinished }: { projectId: string; refreshKey: number; onBatchFinished: (run: DiscoveryRun) => void }) {
  const { data: jobs, refetch } = useAsync(() => Promise.resolve(api.jobs.listByProject(projectId)).catch(() => [] as DiscoveryJob[]), [projectId, refreshKey]);
  const latest = Array.isArray(jobs) ? jobs[0] ?? null : null;
  const active = latest !== null && ACTIVE.has(latest.status);
  const { data: polled } = usePolling(() => api.jobs.get(latest!.id), {
    enabled: active, key: latest?.id ?? null, intervalMs: 4000, stopWhen: job => !ACTIVE.has(job.status),
  });
  const [override, setOverride] = useState<DiscoveryJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = [override, polled, latest].filter((job): job is DiscoveryJob => Boolean(job) && job!.id === latest?.id);
  const job = candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;

  // A batch that finished since the last poll: show its results on the page.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!job) return;
    const finished = job.batches.filter(batch => batch.status !== 'running' && batch.status !== 'pending');
    if (seen.current === null) { seen.current = new Set(finished.map(batch => batch.runId)); return; }
    const fresh = finished.filter(batch => !seen.current!.has(batch.runId)).sort((a, b) => a.batch - b.batch);
    for (const batch of fresh) seen.current.add(batch.runId);
    const newest = fresh.at(-1);
    if (newest) Promise.resolve(api.runs.get(newest.runId)).then(onBatchFinished).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.updatedAt]);

  if (!job) return null;
  async function act(name: 'pause' | 'resume' | 'stop') {
    setBusy(true); setError(null);
    try { setOverride(await api.jobs[name](job!.id)); await refetch(); } catch (err) {
      setError(err instanceof ApiError ? err.message : 'De actie kon niet worden uitgevoerd.');
    } finally { setBusy(false); }
  }
  const [label, tone] = STATUS_TEXT[job.status];
  const { usage, limits } = job;
  return (
    <section aria-label="Uitgebreide verwerking" className="rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-700">Uitgebreide verwerking <Badge tone={tone}>{label}</Badge></p>
        <div className="flex gap-2">
          {(job.status === 'queued' || job.status === 'running') && <Button type="button" variant="secondary" disabled={busy} onClick={() => act('pause')}>Pauzeren</Button>}
          {job.status === 'paused' && <Button type="button" variant="secondary" disabled={busy} onClick={() => act('resume')}>Hervatten</Button>}
          {(job.status === 'queued' || job.status === 'running' || job.status === 'paused') && <Button type="button" variant="secondary" disabled={busy} onClick={() => act('stop')}>Stoppen</Button>}
        </div>
      </div>
      <p className="mt-2" role="status">
        {usage.candidatesResearched} van maximaal {limits.maxCandidates} kandidaat-bedrijven onderzocht
        {usage.candidatesRemaining !== null ? ` · ${usage.candidatesRemaining} wachten nog` : ''}
        {' '}· {usage.batches} batch{usage.batches === 1 ? '' : 'es'}{usage.batchesFailed ? ` (${usage.batchesFailed} mislukt)` : ''}
        {' '}· {usage.searchQueries} zoekopdracht{usage.searchQueries === 1 ? '' : 'en'} · {usage.recordsCreated} nieuw, {usage.recordsUpdated} bijgewerkt
      </p>
      {job.message && <p className="mt-1 text-xs text-slate-600">{job.message}</p>}
      <p className="mt-1 text-xs text-slate-500">Alleen de eerste batch zoekt op het web; volgende batches onderzoeken de gevonden kandidaten zonder opnieuw te zoeken. Resultaten verschijnen per afgeronde batch.</p>
      <FieldError>{error}</FieldError>
    </section>
  );
}
