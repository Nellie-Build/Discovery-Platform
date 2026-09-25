import type { Queryable } from '../connection.js';

/**
 * The Module Registry's own row shape — generic on purpose (see migrations/004_admin_modules.sql):
 * this file knows nothing about vacancies/companies/housing specifically, only that some `id`
 * string names a module a project's own `domain` column can reference.
 */
export interface DiscoveryModuleDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: string;
  version: string;
  capabilities: string[];
  config: Record<string, unknown>;
  updated_at: Date;
}

/**
 * One module as seen from one workspace (see migrations/008_workspace_modules.sql): the global switch,
 * the workspace's own explicit decision (null = none, follows the global switch) and the result.
 */
export interface WorkspaceModuleAccess {
  workspace_id: string;
  module_id: string;
  module_name: string;
  global_enabled: boolean;
  workspace_enabled: boolean | null;
  enabled: boolean;
}

const ACCESS_COLUMNS = `w.id AS workspace_id, m.id AS module_id, m.name AS module_name, m.enabled AS global_enabled,
  wm.enabled AS workspace_enabled, (m.enabled AND COALESCE(wm.enabled, true)) AS enabled`;

export class ModulesRepository {
  constructor(private readonly db: Queryable) {}

  async listModules(): Promise<DiscoveryModuleDefinition[]> {
    const { rows } = await this.db.query<DiscoveryModuleDefinition>('SELECT * FROM modules ORDER BY id');
    return rows;
  }

  async getModule(id: string): Promise<DiscoveryModuleDefinition | null> {
    const { rows } = await this.db.query<DiscoveryModuleDefinition>('SELECT * FROM modules WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<DiscoveryModuleDefinition | null> {
    const { rows } = await this.db.query<DiscoveryModuleDefinition>(
      `UPDATE modules SET enabled = $2, status = CASE WHEN $2 THEN 'active' ELSE 'disabled' END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, enabled],
    );
    return rows[0] ?? null;
  }

  /** Every module as seen from one workspace (empty when the workspace does not exist). */
  async listWorkspaceAccess(workspaceId: string): Promise<WorkspaceModuleAccess[]> {
    const { rows } = await this.db.query<WorkspaceModuleAccess>(
      `SELECT ${ACCESS_COLUMNS} FROM workspaces w CROSS JOIN modules m
       LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = m.id
       WHERE w.id = $1 ORDER BY m.id`,
      [workspaceId],
    );
    return rows;
  }

  /** Every workspace x every module — admin-only. */
  async listAllWorkspaceAccess(): Promise<Array<WorkspaceModuleAccess & { workspace_name: string }>> {
    const { rows } = await this.db.query<WorkspaceModuleAccess & { workspace_name: string }>(
      `SELECT ${ACCESS_COLUMNS}, w.name AS workspace_name FROM workspaces w CROSS JOIN modules m
       LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = m.id
       ORDER BY w.created_at, w.id, m.id`,
    );
    return rows;
  }

  /** The workspace's own decision for one module; `null` removes it, so the workspace follows the global switch again. */
  async setWorkspaceEnabled(workspaceId: string, moduleId: string, enabled: boolean | null, updatedBy: string | null): Promise<void> {
    if (enabled === null) {
      await this.db.query('DELETE FROM workspace_modules WHERE workspace_id = $1 AND module_id = $2', [workspaceId, moduleId]);
      return;
    }
    await this.db.query(
      `INSERT INTO workspace_modules (workspace_id, module_id, enabled, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, module_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [workspaceId, moduleId, enabled, updatedBy],
    );
  }
}
