// Mirrors the JSON shapes apps/api actually returns (see apps/api/src/routes/*.ts and
// packages/discovery-db's repositories) — this package's only job is to keep these in one place
// instead of scattered, hand-written response types across the Web App.

export interface PublicUser {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMembership extends Workspace {
  role: 'owner' | 'member';
}

export interface Project {
  id: string;
  workspace_id: string;
  name: string;
  domain: string;
  status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryRun {
  id: string;
  project_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  started_at: string | null;
  completed_at: string | null;
  stats: Record<string, unknown>;
  error: string | null;
  created_at: string;
  /** Only present on the response to POST /projects/:id/runs itself. */
  recordsCreated?: number;
}

export interface DiscoveryRecord {
  id: string;
  project_id: string;
  domain: string;
  status: string;
  display_name: string | null;
  domain_data: Record<string, unknown>;
  classification: Record<string, unknown>;
  score: number | null;
  created_at: string;
  updated_at: string;
}

export interface RecordSource {
  id: string;
  record_id: string;
  source_type: string;
  source_url: string | null;
  source_label: string | null;
  source_data: Record<string, unknown>;
  discovered_at: string;
}

export interface RecordContact {
  id: string;
  record_id: string;
  type: string;
  value: string;
  normalized_value: string | null;
  source_id: string | null;
  confirmed: boolean;
  created_at: string;
}

export interface RecordWithDetails extends DiscoveryRecord {
  sources: RecordSource[];
  contacts: RecordContact[];
}

/** Thrown by every client method on a non-2xx response — never a raw fetch Response, and never
 * a silently-undefined value the caller has to guess about. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
