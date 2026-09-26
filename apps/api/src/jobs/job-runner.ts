import { randomUUID } from 'node:crypto';
import {
  DiscoveryJobsRepository, DiscoveryRunsRepository, ProjectsRepository, WorkspaceMembersRepository,
  type DiscoveryJob, type DiscoveryRun, type TransactionCapable,
} from '@discovery-platform/db';
import { assertModuleEnabled } from '../module-registry.js';
import { ABSOLUTE_MAX_DURATION_MS, type DomainRegistry } from '../domain-registry.js';
import { discoveryInputFrom, executeRun, loadContinuation } from '../run-executor.js';
import { HttpError } from '../http-errors.js';

/**
 * Extended processing: one user-started search, run as a series of bounded batches in the background. The first batch
 * searches (the only one that uses search-provider credits) and researches the first candidates; every next batch
 * researches the candidates the previous batch left (its continuation), without searching again. The job row
 * (discovery_jobs) is the durable state, so a server restart loses nothing and repeats nothing without bound:
 *  - a worker claims a job with a lease; a second worker (or process) never runs the same job at the same time;
 *  - a batch that did not finish (a crash) is marked failed and the job continues from the last batch that did, so the
 *    remaining candidates are never lost and records are never stored twice (the domain deduplicates, as for any run);
 *  - a first batch that did not finish is NOT repeated automatically (that would search again): the job pauses and the
 *    user decides;
 *  - the user's limits are hard totals across all batches (candidates researched, batches, search queries), and a batch
 *    that keeps failing stops the job after MAX_ATTEMPTS;
 *  - every batch checks again that the project exists, the module is enabled for its workspace and the user who started
 *    the job is still a member of it.
 * Nothing here starts a job: only POST /projects/:id/jobs creates one, and a stopped/completed/failed job never restarts.
 */

export interface JobLimits {
  /** Candidate companies researched in total, over all batches. */
  maxCandidates: number;
  /** Candidate companies per batch. */
  batchSize: number;
  pagesPerCompany: number;
  /** Search queries of the first (searching) batch. */
  maxSearchQueries: number;
  /** Batches started in total, failed ones included: the hard stop against repetition. */
  maxBatches: number;
}
export const JOB_LIMIT_CEILINGS = { maxCandidates: 100, batchSize: 10, pagesPerCompany: 12, maxSearchQueries: 12 } as const;
const JOB_LIMIT_DEFAULTS = { maxCandidates: 30, batchSize: 5, pagesPerCompany: 5, maxSearchQueries: 6 } as const;
export const MAX_ATTEMPTS = 3;

const clamp = (value: unknown, fallback: number, max: number) =>
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value))) : fallback);

/** The user's limits, clamped to their ceilings; never trusted as given. */
export function resolveJobLimits(raw: unknown): JobLimits {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const maxCandidates = clamp(input.maxCandidates, JOB_LIMIT_DEFAULTS.maxCandidates, JOB_LIMIT_CEILINGS.maxCandidates);
  const batchSize = Math.min(maxCandidates, clamp(input.batchSize, JOB_LIMIT_DEFAULTS.batchSize, JOB_LIMIT_CEILINGS.batchSize));
  return {
    maxCandidates, batchSize,
    pagesPerCompany: clamp(input.pagesPerCompany, JOB_LIMIT_DEFAULTS.pagesPerCompany, JOB_LIMIT_CEILINGS.pagesPerCompany),
    maxSearchQueries: clamp(input.maxSearchQueries, JOB_LIMIT_DEFAULTS.maxSearchQueries, JOB_LIMIT_CEILINGS.maxSearchQueries),
    // Enough batches for every candidate, plus a few retries; never more.
    maxBatches: Math.ceil(maxCandidates / batchSize) + MAX_ATTEMPTS,
  };
}

export interface JobUsage {
  batches: number;
  batchesFailed: number;
  candidatesResearched: number;
  searchQueries: number;
  pagesVisited: number;
  recordsCreated: number;
  recordsUpdated: number;
  candidatesRemaining: number | null;
}
export function jobUsage(job: Pick<DiscoveryJob, 'usage'>): JobUsage {
  const u = job.usage ?? {};
  const n = (key: string) => (typeof u[key] === 'number' ? u[key] as number : 0);
  return {
    batches: n('batches'), batchesFailed: n('batchesFailed'), candidatesResearched: n('candidatesResearched'), searchQueries: n('searchQueries'),
    pagesVisited: n('pagesVisited'), recordsCreated: n('recordsCreated'), recordsUpdated: n('recordsUpdated'),
    candidatesRemaining: typeof u.candidatesRemaining === 'number' ? u.candidatesRemaining : null,
  };
}
export function jobLimits(job: Pick<DiscoveryJob, 'limits'>): JobLimits { return resolveJobLimits(job.limits); }

export interface JobRunnerOptions {
  /** Identifies this process in the lease; unique per process by default. */
  owner?: string;
  /** How long a claimed job stays with this worker; longer than any batch can take. */
  leaseMs?: number;
  /** Jobs processed at the same time by this process. */
  concurrency?: number;
  intervalMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface JobRunner {
  /** Claims and runs at most one batch of one due job; true when it did. Tests drive the runner with this. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function createJobRunner(pool: TransactionCapable, registry: DomainRegistry, options: JobRunnerOptions = {}): JobRunner {
  const owner = options.owner ?? `api-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? ABSOLUTE_MAX_DURATION_MS + 60_000;
  const log = options.log ?? (() => {});
  const jobs = new DiscoveryJobsRepository(pool);
  const runs = new DiscoveryRunsRepository(pool);
  const projects = new ProjectsRepository(pool);
  const members = new WorkspaceMembersRepository(pool);

  async function runBatch(job: DiscoveryJob): Promise<void> {
    const usage = jobUsage(job);
    const limits = jobLimits(job);
    const end = (next: 'completed' | 'failed' | 'paused', message: string, extra: Partial<{ lastRunId: string }> = {}) =>
      jobs.release(job.id, owner, { next, usage: { ...usage }, message, ...extra });

    // Identity and access, again for every batch: the project, the module for its workspace, the user who started it.
    const project = await projects.getProjectById(job.project_id);
    if (!project) { await jobs.finishWithoutLease(job.id, 'stopped', 'Het project bestaat niet meer.'); return; }
    const adapter = registry[project.domain];
    if (!adapter?.backgroundJobs) { await jobs.finishWithoutLease(job.id, 'failed', 'Deze module ondersteunt geen uitgebreide verwerking.'); return; }
    try { await assertModuleEnabled(pool, project.domain, project.workspace_id); } catch {
      await jobs.finishWithoutLease(job.id, 'stopped', 'De module is niet (meer) beschikbaar voor deze workspace.'); return;
    }
    if (job.created_by && !(await members.isMember(project.workspace_id, job.created_by))) {
      await jobs.finishWithoutLease(job.id, 'stopped', 'De gebruiker die deze verwerking startte, heeft geen toegang meer tot de workspace.'); return;
    }

    // A batch that was in progress when its worker stopped (a restart): it failed; its candidates are still in the last
    // finished batch's continuation.
    if (job.current_run_id) {
      const orphan = await runs.getRunById(job.current_run_id);
      if (orphan?.status === 'running') await runs.markFailed(orphan.id, 'Onderbroken: de verwerking stopte tijdens deze batch (bijvoorbeeld door een herstart).', orphan.stats);
      usage.batchesFailed++;
      // The first batch searches: repeating it would use search credits again, which only the user may decide.
      if (!job.last_run_id) { await end('paused', 'De eerste batch (zoeken) werd onderbroken. Hervat om opnieuw te zoeken, of stop.'); return; }
    }
    if (job.attempts > MAX_ATTEMPTS) { await end('failed', `Gestopt: een batch mislukte ${MAX_ATTEMPTS} keer achter elkaar.`); return; }

    // Hard limits over all batches.
    const remainingBudget = limits.maxCandidates - usage.candidatesResearched;
    if (remainingBudget <= 0) { await end('completed', 'Het maximum aantal kandidaten is onderzocht.'); return; }
    if (usage.batches >= limits.maxBatches) { await end('completed', 'Het maximum aantal batches is bereikt.'); return; }

    // The next batch: the first one searches with the job's request; every next one continues the last finished batch.
    let request: Record<string, unknown>;
    let continuation: Awaited<ReturnType<typeof loadContinuation>>['continuation'] | undefined;
    if (job.last_run_id) {
      const last = await runs.getRunById(job.last_run_id);
      if (!last || !(last.stats as Record<string, unknown>)?.continuation) { await end('completed', 'Alle gevonden kandidaten zijn onderzocht.'); return; }
      try {
        const loaded = await loadContinuation(pool, project.id, job.last_run_id);
        request = loaded.request; continuation = loaded.continuation;
      } catch (error) {
        await end('failed', error instanceof HttpError ? error.message : 'De vervolgbatch kon niet worden gelezen.'); return;
      }
    } else {
      request = job.request;
    }
    const size = Math.min(limits.batchSize, remainingBudget);
    const filters = { ...(request.filters as Record<string, unknown> | undefined ?? {}), maxCompanies: size, pagesPerCompany: limits.pagesPerCompany, maxQueries: limits.maxSearchQueries };
    const runConfig = { ...(request.runConfig as Record<string, unknown> | undefined ?? {}), targetRecords: size };
    let input;
    try { input = discoveryInputFrom({ ...request, filters, runConfig }, project.domain); } catch (error) {
      await end('failed', error instanceof HttpError ? error.message : 'Ongeldige zoekopdracht.'); return;
    }

    usage.batches++;
    const batchNumber = continuation?.batch ?? 1;
    const execution = await executeRun(pool, adapter, project, input, {
      continuation, extraStats: { jobId: job.id, batch: batchNumber },
      onRunCreated: async run => { await jobs.setCurrentRun(job.id, owner, run.id); },
    });
    const run: DiscoveryRun = execution.run;
    const stats = (run.stats ?? {}) as Record<string, unknown>;
    if (run.status === 'failed') {
      usage.batchesFailed++;
      log('discovery job batch failed', { jobId: job.id, runId: run.id, error: run.error });
      // A failed first batch is not retried: a retry would search (and use credits) again.
      if (!job.last_run_id) { await end('failed', run.error ?? 'De eerste batch is mislukt.'); return; }
      // A failed follow-up batch leaves the continuation of the last finished batch untouched: the next attempt
      // researches the same candidates. Attempts are not reset, so this cannot repeat without bound.
      await jobs.release(job.id, owner, { next: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', usage: { ...usage }, message: `Batch ${batchNumber} mislukt: ${run.error ?? 'onbekende fout'}` });
      return;
    }
    usage.candidatesResearched += num(stats.companiesResearched) + (Array.isArray(stats.sitesFailed) ? stats.sitesFailed.length : 0);
    usage.searchQueries += Array.isArray(stats.queries) ? stats.queries.length : 0;
    usage.pagesVisited += num(stats.pagesVisited);
    usage.recordsCreated += execution.recordsCreated;
    usage.recordsUpdated += execution.recordsUpdated;
    const left = stats.continuation as { remaining?: unknown } | null | undefined;
    usage.candidatesRemaining = left ? num(left.remaining) : 0;
    const more = Boolean(left) && usage.candidatesResearched < limits.maxCandidates && usage.batches < limits.maxBatches;
    await jobs.release(job.id, owner, {
      next: more ? 'queued' : 'completed', usage: { ...usage }, lastRunId: run.id, resetAttempts: true,
      message: more ? null : !left ? 'Alle gevonden kandidaten zijn onderzocht.' : usage.candidatesResearched >= limits.maxCandidates ? 'Het maximum aantal kandidaten is onderzocht.' : 'Het maximum aantal batches is bereikt.',
    });
  }

  async function tick(): Promise<boolean> {
    await jobs.sweepAbandonedStops();
    const job = await jobs.claimNext(owner, leaseMs);
    if (!job) return false;
    try {
      await runBatch(job);
    } catch (error) {
      // An unexpected error (e.g. the database went away): the lease is released so the job is picked up again later;
      // attempts were already counted on the claim, so this cannot loop without bound.
      log('discovery job batch error', { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
      await jobs.release(job.id, owner, { next: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', usage: job.usage, message: 'Een batch kon niet worden verwerkt.' }).catch(() => null);
    }
    return true;
  }

  let timer: NodeJS.Timeout | null = null;
  let inFlight = 0;
  const running = new Set<Promise<unknown>>();
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1));
  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // One claim attempt per free slot per interval: at most `concurrency` jobs at once, each claimed by one worker only.
        for (let slot = inFlight; slot < concurrency; slot++) {
          inFlight++;
          const work: Promise<unknown> = tick().catch(error => log('discovery job runner error', { error: error instanceof Error ? error.message : String(error) }))
            .finally(() => { inFlight--; running.delete(work); });
          running.add(work);
        }
      }, options.intervalMs ?? 5_000);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.allSettled([...running]);
    },
  };
}
