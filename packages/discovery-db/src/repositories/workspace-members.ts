import type { Queryable } from '../connection.js';

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'member';
  created_at: Date;
}

export class WorkspaceMembersRepository {
  constructor(private readonly db: Queryable) {}

  async addMember(workspaceId: string, userId: string, role: 'owner' | 'member' = 'member'): Promise<WorkspaceMember> {
    const { rows } = await this.db.query<WorkspaceMember>(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
      [workspaceId, userId, role],
    );
    return rows[0];
  }

  /** The one check every workspace-scoped route in apps/api relies on — see
   * apps/api/src/workspace-access.ts. Never trust a workspace/project id from the client alone. */
  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId],
    );
    return rows.length > 0;
  }

  /** Every workspace a user belongs to — the only "list workspaces" query in this package;
   * there is deliberately no query that lists every workspace regardless of membership. */
  async listWorkspacesForUser(userId: string): Promise<Array<{ id: string; name: string; role: string; created_at: Date; updated_at: Date }>> {
    const { rows } = await this.db.query(
      `SELECT w.id, w.name, wm.role, w.created_at, w.updated_at
       FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1 ORDER BY w.created_at ASC`,
      [userId],
    );
    return rows as Array<{ id: string; name: string; role: string; created_at: Date; updated_at: Date }>;
  }
}
