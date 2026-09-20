import type { Queryable } from '../connection.js';

export interface DiscoveryRun {
  id: string;
  project_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  stats: Record<string, unknown>;
  error: string | null;
  created_at: Date;
}

export class DiscoveryRunsRepository {
  constructor(private readonly db: Queryable) {}

  async createRun(projectId: string, stats: Record<string, unknown> = {}): Promise<DiscoveryRun> {
    const { rows } = await this.db.query<DiscoveryRun>(
      `INSERT INTO discovery_runs (project_id, status, started_at, stats) VALUES ($1, 'running', now(), $2::jsonb) RETURNING *`,
      [projectId, JSON.stringify(stats)],
    );
    return rows[0];
  }

  async markSucceeded(runId: string, stats: Record<string, unknown>): Promise<DiscoveryRun> {
    const { rows } = await this.db.query<DiscoveryRun>(
      `UPDATE discovery_runs SET status = 'succeeded', stats = $2::jsonb, completed_at = now() WHERE id = $1 RETURNING *`,
      [runId, JSON.stringify(stats)],
    );
    return rows[0];
  }

  async finish(runId: string, status: 'succeeded' | 'partial' | 'failed', stats: Record<string, unknown>): Promise<DiscoveryRun> {
    const { rows } = await this.db.query<DiscoveryRun>(
      'UPDATE discovery_runs SET status = $2, stats = $3::jsonb, completed_at = now() WHERE id = $1 RETURNING *',
      [runId, status, JSON.stringify(stats)]);
    return rows[0];
  }

  async markFailed(runId: string, error: string, stats: Record<string, unknown> = {}): Promise<DiscoveryRun> {
    const { rows } = await this.db.query<DiscoveryRun>(
      `UPDATE discovery_runs SET status = 'failed', error = $2, stats = $3::jsonb, completed_at = now() WHERE id = $1 RETURNING *`,
      [runId, error, JSON.stringify(stats)],
    );
    return rows[0];
  }

  async getRunById(id: string): Promise<DiscoveryRun | null> {
    const { rows } = await this.db.query<DiscoveryRun>('SELECT * FROM discovery_runs WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listRunsByProject(projectId: string): Promise<DiscoveryRun[]> {
    const { rows } = await this.db.query<DiscoveryRun>(
      'SELECT * FROM discovery_runs WHERE project_id = $1 ORDER BY created_at DESC', [projectId],
    );
    return rows;
  }
}
