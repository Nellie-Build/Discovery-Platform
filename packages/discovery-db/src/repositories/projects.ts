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

  async getProjectById(id: string): Promise<Project | null> {
    const { rows } = await this.db.query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  /** Always scoped to one workspace — the isolation boundary between tenants, even before any
   * real multi-tenant auth exists (see docs/architecture.md). There is no "list all projects
   * across every workspace" query in this repository at all. */
  async listProjectsByWorkspace(workspaceId: string): Promise<Project[]> {
    const { rows } = await this.db.query<Project>(
      'SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at DESC', [workspaceId],
    );
    return rows;
  }
}
