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
  async listRecordsByProject(projectId: string, options: { domain?: string } = {}): Promise<DiscoveryRecord[]> {
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
