import type { Queryable } from '../connection.js';

/**
 * The Source Registry's own row shape — data model only for this phase (see
 * migrations/005_source_registry.sql): no route or UI reads/writes this table yet. `module` is a
 * plain string (matches `modules.id`), so this stays reusable by any future module, not just
 * vacancies.
 */
export interface SourceDefinition {
  id: string;
  module: string;
  name: string;
  base_url: string | null;
  type: string;
  enabled: boolean;
  priority: number;
  metadata: Record<string, unknown>;
  last_successful_run: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export class SourcesRepository {
  constructor(private readonly db: Queryable) {}

  async listByModule(module: string): Promise<SourceDefinition[]> {
    const { rows } = await this.db.query<SourceDefinition>(
      'SELECT * FROM sources WHERE module = $1 ORDER BY priority DESC, name', [module],
    );
    return rows;
  }
}
