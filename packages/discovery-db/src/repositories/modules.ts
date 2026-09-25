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
 * One module as seen from one workspace — a row of the `workspace_module_access` view (migrations/009_module_packages.sql),
 * the one definition of access: the global switch, what the workspace's package includes, the workspace's own individual
 * choice (null = none, follow the package), whether that choice deviates from the package, and the result.
 */
export interface WorkspaceModuleAccess {
  workspace_id: string;
  module_id: string;
  module_name: string;
  package_id: string;
  global_enabled: boolean;
  package_included: boolean;
  workspace_enabled: boolean | null;
  deviates: boolean;
  enabled: boolean;
}

/** A module package: a named set of modules; `is_custom` includes none by itself (every module is chosen individually). */
export interface ModulePackage {
  id: string;
  name: string;
  description: string;
  is_custom: boolean;
  sort_order: number;
  module_ids: string[];
}

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

  /** Every package with the modules it includes, in display order. */
  async listPackages(): Promise<ModulePackage[]> {
    const { rows } = await this.db.query<ModulePackage>(
      `SELECT p.*, COALESCE(array_agg(pm.module_id ORDER BY pm.module_id) FILTER (WHERE pm.module_id IS NOT NULL), '{}') AS module_ids
       FROM module_packages p LEFT JOIN module_package_modules pm ON pm.package_id = p.id
       GROUP BY p.id ORDER BY p.sort_order, p.id`,
    );
    return rows;
  }

  /** Every module as seen from one workspace (empty when the workspace does not exist). */
  async listWorkspaceAccess(workspaceId: string): Promise<WorkspaceModuleAccess[]> {
    const { rows } = await this.db.query<WorkspaceModuleAccess>(
      'SELECT * FROM workspace_module_access WHERE workspace_id = $1 ORDER BY module_id',
      [workspaceId],
    );
    return rows;
  }

  /** Every workspace x every module — admin-only. */
  async listAllWorkspaceAccess(): Promise<Array<WorkspaceModuleAccess & { workspace_name: string; package_name: string }>> {
    const { rows } = await this.db.query<WorkspaceModuleAccess & { workspace_name: string; package_name: string }>(
      `SELECT a.*, w.name AS workspace_name, p.name AS package_name
       FROM workspace_module_access a JOIN workspaces w ON w.id = a.workspace_id JOIN module_packages p ON p.id = a.package_id
       ORDER BY w.created_at, w.id, a.module_id`,
    );
    return rows;
  }

  /**
   * Gives a workspace a package. Run it in a transaction. A regular package starts clean: the workspace's individual
   * choices are removed, so it gets exactly what the package includes. Switching to the custom package keeps what the
   * workspace has: every module's current choice (individual, or else from the old package) becomes an individual choice.
   * Projects, runs and records are never touched. Returns false when the package does not exist.
   */
  async setWorkspacePackage(workspaceId: string, packageId: string, updatedBy: string | null): Promise<boolean> {
    const { rows } = await this.db.query<{ is_custom: boolean }>('SELECT is_custom FROM module_packages WHERE id = $1', [packageId]);
    if (!rows[0]) return false;
    if (rows[0].is_custom) {
      await this.db.query(
        `INSERT INTO workspace_modules (workspace_id, module_id, enabled, updated_by)
         SELECT workspace_id, module_id, package_included, $2 FROM workspace_module_access WHERE workspace_id = $1 AND workspace_enabled IS NULL
         ON CONFLICT (workspace_id, module_id) DO NOTHING`,
        [workspaceId, updatedBy],
      );
    } else {
      await this.db.query('DELETE FROM workspace_modules WHERE workspace_id = $1', [workspaceId]);
    }
    await this.db.query('UPDATE workspaces SET module_package_id = $2 WHERE id = $1', [workspaceId, packageId]);
    return true;
  }

  /** The workspace's own choice for one module; `null` removes it, so the workspace follows its package again. */
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
