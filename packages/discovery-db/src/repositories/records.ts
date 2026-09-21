import type { Queryable } from '../connection.js';

export interface DiscoveryRecord {
  id: string;
  project_id: string;
  domain: string;
  status: string;
  display_name: string | null;
  domain_data: Record<string, unknown>;
  classification: Record<string, unknown>;
  score: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecordSource {
  id: string;
  record_id: string;
  source_type: string;
  source_url: string | null;
  source_label: string | null;
  source_data: Record<string, unknown>;
  discovered_at: Date;
}

export interface RecordContact {
  id: string;
  record_id: string;
  type: string;
  value: string;
  normalized_value: string | null;
  source_id: string | null;
  confirmed: boolean;
  created_at: Date;
}

export interface RecordWithDetails extends DiscoveryRecord {
  sources: RecordSource[];
  contacts: RecordContact[];
}

export interface NewRecordInput {
  projectId: string;
  domain: string;
  displayName: string | null;
  domainData: Record<string, unknown>;
  classification?: Record<string, unknown>;
  score?: number | null;
  sources?: Array<{ sourceType: string; sourceUrl?: string | null; sourceLabel?: string | null; sourceData?: Record<string, unknown> }>;
  contacts?: Array<{ type: string; value: string; normalizedValue?: string | null; confirmed?: boolean }>;
}

export class DiscoveryRecordsRepository {
  constructor(private readonly db: Queryable) {}

  async observeInRun(runId: string, record: DiscoveryRecord): Promise<void> {
    await this.db.query(`INSERT INTO discovery_run_records (run_id, record_id, snapshot)
      SELECT u.id, r.id, $3::jsonb FROM discovery_runs u JOIN discovery_records r ON r.project_id = u.project_id
      WHERE u.id = $1 AND r.id = $2 ON CONFLICT (run_id, record_id) DO NOTHING`,
      [runId, record.id, JSON.stringify(record)]);
  }

  /**
   * Replaces what a record says about itself (display name, domain facts, classification, score) after a later
   * run found newer information about the same real-world record, and stamps `updated_at`. Scoped to a project so
   * a record of another project can never be touched. Returns null when there is no such record in that project.
   */
  async updateRecordFacts(id: string, projectId: string, update: { displayName: string | null; domainData: Record<string, unknown>; classification?: Record<string, unknown>; score?: number | null }): Promise<DiscoveryRecord | null> {
    const { rows } = await this.db.query<DiscoveryRecord>(
      `UPDATE discovery_records SET display_name = $3, domain_data = $4::jsonb, classification = $5::jsonb, score = $6, updated_at = now()
       WHERE id = $1 AND project_id = $2 RETURNING *`,
      [id, projectId, update.displayName, JSON.stringify(update.domainData), JSON.stringify(update.classification ?? {}), update.score ?? null],
    );
    return rows[0] ?? null;
  }

  /** Adds provenance rows a record does not have yet (same source type and URL = already there). Returns how many were added. */
  async addSourcesIfMissing(recordId: string, sources: NonNullable<NewRecordInput['sources']>): Promise<number> {
    let added = 0;
    for (const source of sources) {
      const { rows } = await this.db.query(
        `INSERT INTO record_sources (record_id, source_type, source_url, source_label, source_data)
         SELECT $1, $2, $3, $4, $5::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM record_sources WHERE record_id = $1 AND source_type = $2 AND source_url IS NOT DISTINCT FROM $3) RETURNING id`,
        [recordId, source.sourceType, source.sourceUrl ?? null, source.sourceLabel ?? null, JSON.stringify(source.sourceData ?? {})],
      );
      added += rows.length;
    }
    return added;
  }

  /** Inserts one record together with its sources and contacts. Callers that need several
   * records to succeed or fail together (a whole discovery run's worth) should construct this
   * repository with a transaction client (see connection.ts's `withTransaction`) and call this
   * once per record within that same transaction. */
  async createRecordWithDetails(input: NewRecordInput): Promise<RecordWithDetails> {
    const { rows: recordRows } = await this.db.query<DiscoveryRecord>(
      `INSERT INTO discovery_records (project_id, domain, display_name, domain_data, classification, score)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [input.projectId, input.domain, input.displayName, JSON.stringify(input.domainData),
        JSON.stringify(input.classification ?? {}), input.score ?? null],
    );
    const record = recordRows[0];

    const sources: RecordSource[] = [];
    for (const source of input.sources ?? []) {
      const { rows } = await this.db.query<RecordSource>(
        `INSERT INTO record_sources (record_id, source_type, source_url, source_label, source_data)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
        [record.id, source.sourceType, source.sourceUrl ?? null, source.sourceLabel ?? null, JSON.stringify(source.sourceData ?? {})],
      );
      sources.push(rows[0]);
    }

    const contacts: RecordContact[] = [];
    for (const contact of input.contacts ?? []) {
      const { rows } = await this.db.query<RecordContact>(
        `INSERT INTO record_contacts (record_id, type, value, normalized_value, confirmed)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [record.id, contact.type, contact.value, contact.normalizedValue ?? null, contact.confirmed ?? false],
      );
      contacts.push(rows[0]);
    }

    return { ...record, sources, contacts };
  }

  async getRecordById(id: string): Promise<RecordWithDetails | null> {
    const { rows } = await this.db.query<DiscoveryRecord>('SELECT * FROM discovery_records WHERE id = $1', [id]);
    const record = rows[0];
    if (!record) return null;
    const { rows: sources } = await this.db.query<RecordSource>(
      'SELECT * FROM record_sources WHERE record_id = $1 ORDER BY discovered_at ASC', [id],
    );
    const { rows: contacts } = await this.db.query<RecordContact>(
      'SELECT * FROM record_contacts WHERE record_id = $1 ORDER BY created_at ASC', [id],
    );
    return { ...record, sources, contacts };
  }

  /** Always scoped to one project — see ProjectsRepository.listProjectsByWorkspace for the same
   * isolation reasoning at the workspace level. */
  async listRecordsByProject(projectId: string, options: { domain?: string; runId?: string } = {}): Promise<DiscoveryRecord[]> {
    if (options.runId) {
      const { rows } = await this.db.query<{ snapshot: DiscoveryRecord }>(
        `SELECT o.snapshot FROM discovery_run_records o JOIN discovery_records r ON r.id = o.record_id
         JOIN discovery_runs u ON u.id = o.run_id AND u.project_id = r.project_id
         WHERE r.project_id = $1 AND o.run_id = $2 AND ($3::text IS NULL OR r.domain = $3) ORDER BY o.seen_at DESC`,
        [projectId, options.runId, options.domain ?? null]);
      return rows.map(row => row.snapshot);
    }
    if (options.domain) {
      const { rows } = await this.db.query<DiscoveryRecord>(
        'SELECT * FROM discovery_records WHERE project_id = $1 AND domain = $2 ORDER BY created_at DESC',
        [projectId, options.domain],
      );
      return rows;
    }
    const { rows } = await this.db.query<DiscoveryRecord>(
      'SELECT * FROM discovery_records WHERE project_id = $1 ORDER BY created_at DESC', [projectId],
    );
    return rows;
  }
}
