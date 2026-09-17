import type { Queryable } from '../connection.js';

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  status: string;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
}

/** A soft-deleted project joined with just enough of its workspace to render in an admin list —
 * never returned to a normal (non-admin) API caller. */
export interface ProjectWithWorkspace extends Project {
  workspace_name: string;
}

export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  domain: string;
  config?: Record<string, unknown>;
}

export class ProjectsRepository {
  constructor(private readonly db: Queryable) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const { rows } = await this.db.query<Project>(
      `INSERT INTO projects (workspace_id, name, domain, config)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
      [input.workspaceId, input.name, input.domain, JSON.stringify(input.config ?? {})],
    );
    return rows[0];
  }

  /** Excludes a soft-deleted project by default — the one check every route relies on to treat a
   * deleted project as gone (see routes/projects.ts and routes/runs.ts). Admin's own project list
   * is the only caller that ever passes `includeDeleted: true`. */
  async getProjectById(id: string, options: { includeDeleted?: boolean } = {}): Promise<Project | null> {
    const query = options.includeDeleted
      ? 'SELECT * FROM projects WHERE id = $1'
      : 'SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL';
    const { rows } = await this.db.query<Project>(query, [id]);
    return rows[0] ?? null;
  }

  /** Always scoped to one workspace — the isolation boundary between tenants, even before any
   * real multi-tenant auth exists (see docs/architecture.md). There is no "list all projects
   * across every workspace" query in this repository at all. Never includes a soft-deleted
   * project — see listAllForAdmin below for the one place that does. */
  async listProjectsByWorkspace(workspaceId: string): Promise<Project[]> {
    const { rows } = await this.db.query<Project>(
      'SELECT * FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [workspaceId],
    );
    return rows;
  }

  async softDeleteProject(id: string, deletedBy: string | null): Promise<Project | null> {
    const { rows } = await this.db.query<Project>(
      `UPDATE projects SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, deletedBy],
    );
    return rows[0] ?? null;
  }

  async restoreProject(id: string): Promise<Project | null> {
    const { rows } = await this.db.query<Project>(
      `UPDATE projects SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Every project across every workspace, active and soft-deleted alike, each with its own
   * workspace's name — admin-only (see routes/admin.ts); never used by a normal workspace-scoped
   * route (see this repository's own doc comments above). */
  async listAllForAdmin(): Promise<ProjectWithWorkspace[]> {
    const { rows } = await this.db.query<ProjectWithWorkspace>(
      `SELECT projects.*, workspaces.name AS workspace_name
       FROM projects JOIN workspaces ON workspaces.id = projects.workspace_id
       ORDER BY projects.created_at DESC`,
    );
    return rows;
  }
}
