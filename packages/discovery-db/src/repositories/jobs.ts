import type { Queryable } from '../connection.js';

export type DiscoveryJobStatus = 'queued' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed';
export const ACTIVE_JOB_STATUSES: readonly DiscoveryJobStatus[] = ['queued', 'running', 'paused', 'stopping'];

export interface DiscoveryJob {
  id: string;
  project_id: string;
  created_by: string | null;
  status: DiscoveryJobStatus;
  request: Record<string, unknown>;
  limits: Record<string, unknown>;
  usage: Record<string, unknown>;
  last_run_id: string | null;
  current_run_id: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  attempts: number;
  message: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** A unique-index violation: the project already has an unfinished job. */
export class ActiveJobExistsError extends Error {
  constructor() { super('This project already has an active job.'); }
}

/**
 * Discovery jobs (migrations/011_discovery_jobs.sql). Every state change is one conditional UPDATE, so a pause, a stop
 * and a worker finishing a batch can never overwrite each other: each only applies from the states it is valid in.
 */
export class DiscoveryJobsRepository {
  constructor(private readonly db: Queryable) {}

  async createJob(input: { projectId: string; createdBy: string | null; request: Record<string, unknown>; limits: Record<string, unknown> }): Promise<DiscoveryJob> {
    try {
      const { rows } = await this.db.query<DiscoveryJob>(
        `INSERT INTO discovery_jobs (project_id, created_by, request, limits, usage) VALUES ($1, $2, $3::jsonb, $4::jsonb, '{}'::jsonb) RETURNING *`,
        [input.projectId, input.createdBy, JSON.stringify(input.request), JSON.stringify(input.limits)],
      );
      return rows[0];
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new ActiveJobExistsError();
      throw error;
    }
  }

  async getJobById(id: string): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>('SELECT * FROM discovery_jobs WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listJobsByProject(projectId: string, limit = 20): Promise<DiscoveryJob[]> {
    const { rows } = await this.db.query<DiscoveryJob>('SELECT * FROM discovery_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2', [projectId, limit]);
    return rows;
  }

  async getActiveJob(projectId: string): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>(
      `SELECT * FROM discovery_jobs WHERE project_id = $1 AND status IN ('queued', 'running', 'paused', 'stopping') LIMIT 1`, [projectId]);
    return rows[0] ?? null;
  }

  /**
   * Claims one job that is due: queued, or running with an expired lease (its worker stopped). Atomic: the row is locked
   * and skipped by any other claimer, and only one UPDATE wins. `attempts` counts claims since the last finished batch.
   */
  async claimNext(owner: string, leaseMs: number): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET status = 'running', lease_owner = $1, lease_until = now() + ($2::int * interval '1 millisecond'),
         attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM discovery_jobs
         WHERE status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now()))
         ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) AND (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))
       RETURNING *`,
      [owner, Math.max(1_000, Math.floor(leaseMs))],
    );
    return rows[0] ?? null;
  }

  /** The batch a worker is about to run, recorded before it runs (so a crash leaves a trace). Only while it holds the lease. */
  async setCurrentRun(id: string, owner: string, runId: string | null): Promise<boolean> {
    const { rows } = await this.db.query(
      'UPDATE discovery_jobs SET current_run_id = $3, updated_at = now() WHERE id = $1 AND lease_owner = $2 RETURNING id', [id, owner, runId]);
    return rows.length > 0;
  }

  /**
   * A worker is done with a batch: record usage and the last finished run, release the lease and move to the next state.
   * A pause or stop the user asked for while the batch ran wins over `next` (paused stays paused, stopping becomes
   * stopped); a stopped/completed/failed job is never changed back.
   */
  async release(id: string, owner: string, update: {
    next: 'queued' | 'completed' | 'failed' | 'paused';
    usage: Record<string, unknown>;
    lastRunId?: string | null;
    resetAttempts?: boolean;
    message?: string | null;
  }): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET
         status = CASE
           WHEN status = 'stopping' THEN 'stopped'
           WHEN status = 'paused' AND $3 = 'queued' THEN 'paused'
           ELSE $3 END,
         usage = $4::jsonb,
         last_run_id = COALESCE($5, last_run_id),
         current_run_id = NULL,
         attempts = CASE WHEN $6 THEN 0 ELSE attempts END,
         message = $7,
         lease_owner = NULL, lease_until = NULL, updated_at = now(),
         finished_at = CASE WHEN status = 'stopping' OR $3 IN ('completed', 'failed') THEN now() ELSE finished_at END
       WHERE id = $1 AND lease_owner = $2 AND status IN ('running', 'paused', 'stopping')
       RETURNING *`,
      [id, owner, update.next, JSON.stringify(update.usage), update.lastRunId ?? null, update.resetAttempts ?? false, update.message ?? null],
    );
    return rows[0] ?? null;
  }

  /** User actions. Each applies only from the states where it makes sense; null when it does not apply. */
  async pause(id: string): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET status = 'paused', updated_at = now(), message = NULL WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`, [id]);
    return rows[0] ?? null;
  }

  async resume(id: string): Promise<DiscoveryJob | null> {
    // A paused job whose batch is still running (lease held) resumes as running; its worker then queues the next batch.
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET status = CASE WHEN lease_owner IS NOT NULL THEN 'running' ELSE 'queued' END, attempts = 0, message = NULL, updated_at = now()
       WHERE id = $1 AND status = 'paused' RETURNING *`, [id]);
    return rows[0] ?? null;
  }

  async stop(id: string): Promise<DiscoveryJob | null> {
    // A batch in progress is finished safely first (stopping); without one, the job stops at once.
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET
         status = CASE WHEN lease_owner IS NOT NULL AND lease_until > now() THEN 'stopping' ELSE 'stopped' END,
         finished_at = CASE WHEN lease_owner IS NOT NULL AND lease_until > now() THEN NULL ELSE now() END,
         lease_owner = CASE WHEN lease_owner IS NOT NULL AND lease_until > now() THEN lease_owner ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running', 'paused') RETURNING *`, [id]);
    return rows[0] ?? null;
  }

  /** A stop the user asked for while a worker that has since disappeared held the job: it is stopped now. */
  async sweepAbandonedStops(): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE discovery_jobs SET status = 'stopped', lease_owner = NULL, lease_until = NULL, finished_at = now(), updated_at = now()
       WHERE status = 'stopping' AND (lease_until IS NULL OR lease_until < now()) RETURNING id`);
    return rows.length;
  }

  /** Ends a job without a worker (e.g. its project was deleted or the module switched off). */
  async finishWithoutLease(id: string, status: 'stopped' | 'failed', message: string): Promise<DiscoveryJob | null> {
    const { rows } = await this.db.query<DiscoveryJob>(
      `UPDATE discovery_jobs SET status = $2, message = $3, lease_owner = NULL, lease_until = NULL, current_run_id = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running', 'paused', 'stopping') RETURNING *`, [id, status, message]);
    return rows[0] ?? null;
  }
}
