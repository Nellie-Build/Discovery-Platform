import {
  DiscoveryRunsRepository, DiscoveryRecordsRepository, DiscoveryJobsRepository, withTransaction,
  type DiscoveryRun, type Project, type TransactionCapable,
} from '@discovery-platform/db';
import { badRequest, notFound, HttpError } from './http-errors.js';
import { resolveDiscoveryRunConfig, type DiscoveryRunConfig, type DomainAdapter, type RunContinuation } from './domain-registry.js';

/**
 * Running one discovery batch, shared by the HTTP route (POST /projects/:id/runs, one batch per request) and the job
 * runner (jobs/job-runner.ts, batches in the background). Both go through exactly the same request parsing, budget
 * clamping, adapter call and all-or-nothing persistence, so a background batch can never do anything a manual run could
 * not.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DiscoveryInputWithoutRecords =
  | { mode: 'website'; sourceUrl: string; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> }
  | { mode: 'source'; sourceId: string; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> }
  | { mode: 'branch'; branch: string; country: string | null; region: string | null; keywords: string | null; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> };

/**
 * A run request as the adapter's input. `runConfig` is never trusted as given — every field is clamped to its own
 * absolute ceiling here, before the domain adapter ever sees it (see resolveDiscoveryRunConfig). `filters` is opaque,
 * module-owned data apps/api never inspects. Three request shapes: { sourceUrl } starts a website crawl, { sourceId } a
 * named API/feed source, { branch, region?, keywords? } a branch search; which one is inferred from the fields present.
 */
export function discoveryInputFrom(body: Record<string, unknown>, domain: string): DiscoveryInputWithoutRecords {
  const runConfig: DiscoveryRunConfig = resolveDiscoveryRunConfig(
    body.runConfig && typeof body.runConfig === 'object' ? body.runConfig as Partial<DiscoveryRunConfig> : undefined, domain,
  );
  const filters: Record<string, unknown> = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? body.filters as Record<string, unknown> : {};
  if (typeof body.sourceUrl === 'string' && body.sourceUrl.trim()) return { mode: 'website', sourceUrl: body.sourceUrl.trim(), runConfig, filters };
  if (typeof body.sourceId === 'string' && /^[a-z0-9_-]{1,40}$/.test(body.sourceId.trim())) return { mode: 'source', sourceId: body.sourceId.trim(), runConfig, filters };
  if (typeof body.branch === 'string' && body.branch.trim()) {
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return { mode: 'branch', branch: body.branch.trim(), country: text(body.country), region: text(body.region), keywords: text(body.keywords), runConfig, filters };
  }
  throw badRequest('invalid_source', 'sourceUrl, sourceId or branch is required.');
}

/**
 * A follow-up batch of an earlier run: the earlier run's own request and the cursor it left, both read from the database,
 * so a client can neither change the criteria nor hand in candidates. A run can be continued only once; a follow-up that
 * failed (an error, or the loser of a simultaneous request) does not use up the continuation.
 */
export async function loadContinuation(pool: TransactionCapable, projectId: string, runId: unknown): Promise<{ request: Record<string, unknown>; continuation: RunContinuation & { batch: number }; previous: DiscoveryRun }> {
  if (typeof runId !== 'string' || !UUID.test(runId)) throw badRequest('invalid_continuation', 'continueFromRunId must be a run id.');
  const runs = new DiscoveryRunsRepository(pool);
  const previous = await runs.getRunById(runId);
  if (!previous || previous.project_id !== projectId) throw notFound('Run not found.');
  const stats = (previous.stats ?? {}) as Record<string, unknown>;
  const state = stats.continuation as { cursor?: unknown } | null | undefined;
  const original = stats.criteria as Record<string, unknown> | undefined;
  if (!state || typeof state.cursor !== 'string' || !original) throw badRequest('nothing_to_continue', 'Deze run heeft geen vervolgbatch.');
  if ((await runs.listRunsByProject(projectId)).some(other => other.status !== 'failed' && (other.stats as Record<string, unknown> | null)?.continuesRunId === previous.id)) {
    throw new HttpError(409, 'already_continued', 'Deze run is al voortgezet.');
  }
  const { mode: _mode, ...request } = original;
  return { request, previous, continuation: { fromRunId: previous.id, cursor: state.cursor, batch: (typeof stats.batch === 'number' ? stats.batch : 1) + 1 } };
}

/** A run that belongs to an unfinished background job is continued by that job only, never by hand as well. */
export async function assertNotJobManaged(pool: TransactionCapable, previous: DiscoveryRun): Promise<void> {
  const jobId = (previous.stats as Record<string, unknown> | null)?.jobId;
  if (typeof jobId !== 'string') return;
  const job = await new DiscoveryJobsRepository(pool).getJobById(jobId);
  if (job && ['queued', 'running', 'paused', 'stopping'].includes(job.status)) {
    throw new HttpError(409, 'job_managed', 'Deze zoekopdracht wordt op de achtergrond verwerkt; pauzeer of stop die verwerking eerst.');
  }
}

export interface RunExecution { run: DiscoveryRun; recordsCreated: number; recordsUpdated: number }

/**
 * Creates the run, calls the adapter and persists its records. Never throws for a discovery or storage failure: the run
 * is marked failed with a user-facing reason instead. `extraStats` (e.g. the job and batch number) is stored with the run.
 */
export async function executeRun(pool: TransactionCapable, adapter: DomainAdapter, project: Project, input: DiscoveryInputWithoutRecords, options: {
  continuation?: RunContinuation & { batch: number };
  extraStats?: Record<string, unknown>;
  /** Called with the run as soon as it exists (the job runner records it before the batch starts). */
  onRunCreated?: (run: DiscoveryRun) => Promise<void>;
} = {}): Promise<RunExecution> {
  const runs = new DiscoveryRunsRepository(pool);
  const records = new DiscoveryRecordsRepository(pool);
  const { continuation } = options;
  const { runConfig: resolvedConfig, filters: resolvedFilters, ...criteria } = input;
  const initialStats = {
    criteria: { ...criteria, runConfig: resolvedConfig, filters: resolvedFilters },
    ...(continuation ? { continuesRunId: continuation.fromRunId, batch: continuation.batch } : {}),
    ...(options.extraStats ?? {}),
  };
  const run = await runs.createRun(project.id, initialStats);
  if (options.onRunCreated) await options.onRunCreated(run);
  if (continuation) {
    // Two simultaneous continuation requests: only the first-created run continues, the other stops at once.
    const siblings = (await runs.listRunsByProject(project.id)).filter(other => other.status !== 'failed' && (other.stats as Record<string, unknown> | null)?.continuesRunId === continuation.fromRunId);
    const first = siblings.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id))[0];
    if (first && first.id !== run.id) return { run: await runs.markFailed(run.id, 'Deze run is al voortgezet.', initialStats), recordsCreated: 0, recordsUpdated: 0 };
  }

  let outcome;
  try {
    const existing = await records.listRecordsByProject(project.id, { domain: project.domain });
    const existingRecords = existing.map(record => ({ id: record.id, domainData: record.domain_data }));
    outcome = await adapter.runDiscovery({ ...input, existingRecords, ...(continuation ? { continuation: { fromRunId: continuation.fromRunId, cursor: continuation.cursor } } : {}) });
  } catch {
    return { run: await runs.markFailed(run.id, 'Discovery kon niet worden uitgevoerd.', initialStats), recordsCreated: 0, recordsUpdated: 0 };
  }

  let recordsCreated = 0;
  let recordsUpdated = 0;
  try {
    // Every record from this run is persisted in one transaction: if inserting record N fails (a bad value, a lost
    // connection), record 1..N-1 are rolled back too — a run either contributes all of its records, or none of them.
    await withTransaction(pool, async client => {
      const recordsInTransaction = new DiscoveryRecordsRepository(client);
      for (const record of outcome!.records) {
        const stored = record.existingRecordId ? await recordsInTransaction.getRecordById(record.existingRecordId) : await recordsInTransaction.createRecordWithDetails({
          projectId: project.id, domain: project.domain,
          displayName: record.displayName, domainData: record.domainData,
          classification: record.classification, score: record.score,
          sources: record.sources, contacts: record.contacts,
        });
        if (stored && stored.project_id === project.id) {
          await recordsInTransaction.observeInRun(run.id, { ...stored, domain_data: record.domainData, classification: record.classification });
          if (!record.existingRecordId) recordsCreated++;
        }
      }
      // A later run found newer information about a record that already exists: replace its facts (the domain decided
      // what the new facts are), add the provenance it lacked, and note the observation in this run.
      for (const record of outcome!.updatedRecords ?? []) {
        if (!record.existingRecordId) continue;
        const stored = await recordsInTransaction.getRecordById(record.existingRecordId);
        if (!stored || stored.project_id !== project.id || stored.domain !== project.domain) continue;
        const updated = await recordsInTransaction.updateRecordFacts(stored.id, project.id, {
          displayName: record.displayName, domainData: record.domainData, classification: record.classification, score: record.score,
        });
        if (!updated) continue;
        await recordsInTransaction.addSourcesIfMissing(stored.id, record.sources);
        await recordsInTransaction.observeInRun(run.id, updated);
        recordsUpdated++;
      }
      for (const record of outcome!.observedRecords ?? []) {
        if (!record.existingRecordId) continue;
        const stored = await recordsInTransaction.getRecordById(record.existingRecordId);
        if (stored?.project_id === project.id) await recordsInTransaction.observeInRun(run.id, { ...stored, domain_data: record.domainData, classification: record.classification });
      }
    });
  } catch {
    return { run: await runs.markFailed(run.id, 'Resultaten konden niet worden opgeslagen.', { ...outcome.stats, ...initialStats, recordsCreated: 0, recordsUpdated: 0 }), recordsCreated: 0, recordsUpdated: 0 };
  }

  if (outcome.status === 'failed' && outcome.error) {
    return { run: await runs.markFailed(run.id, outcome.error, { ...outcome.stats, ...initialStats, recordsCreated, recordsUpdated }), recordsCreated, recordsUpdated };
  }
  const finished = await runs.finish(run.id, outcome.status ?? 'succeeded', {
    ...outcome.stats, ...initialStats, recordsCreated, recordsUpdated,
    ...(outcome.continuation !== undefined ? { continuation: outcome.continuation } : {}),
  });
  return { run: finished, recordsCreated, recordsUpdated };
}
