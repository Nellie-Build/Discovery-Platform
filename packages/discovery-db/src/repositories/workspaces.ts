import type { Queryable } from '../connection.js';

export interface Workspace {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export class WorkspacesRepository {
  constructor(private readonly db: Queryable) {}

  async createWorkspace(name: string): Promise<Workspace> {
    const { rows } = await this.db.query<Workspace>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING *', [name],
    );
    return rows[0];
  }

  async getWorkspaceById(id: string): Promise<Workspace | null> {
    const { rows } = await this.db.query<Workspace>('SELECT * FROM workspaces WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}
