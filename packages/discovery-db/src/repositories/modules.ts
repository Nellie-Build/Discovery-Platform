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
}
