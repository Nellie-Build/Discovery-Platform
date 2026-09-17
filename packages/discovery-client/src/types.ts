// Mirrors the JSON shapes apps/api actually returns (see apps/api/src/routes/*.ts and
// packages/discovery-db's repositories) — this package's only job is to keep these in one place
// instead of scattered, hand-written response types across the Web App.

export interface PublicUser {
  id: string;
  email: string;
  /** Platform-level admin flag (see migrations/004_admin_modules.sql) — the Web App's own /admin
   * nav link and route guard read this, never a hardcoded email. */
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

/** One row of the Module Registry — see apps/api/src/routes/admin.ts. */
export interface DiscoveryModuleDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: string;
  version: string;
  capabilities: string[];
  config: Record<string, unknown>;
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
  deleted_at: string | null;
  deleted_by: string | null;
}

/** Admin-only: a project (active or soft-deleted) with its workspace's name attached — see
 * apps/api/src/routes/admin.ts. */
export interface AdminProject extends Project {
  workspace_name: string;
}

/** Body for `runs.startBranchSearch` — the "search by branch" alternative to `runs.start`'s
 * plain `sourceUrl`. `region`, `keywords` and `searchBreadth` are all optional. `searchBreadth`
 * is a plain string ("focused" | "standard" | "broad" for the vacancies module today) — the Web
 * App never hardcodes what each tier means, it only offers whatever the domain reports. */
export interface BranchSearchInput {
  branch: string;
  region?: string;
  keywords?: string;
  searchBreadth?: string;
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
