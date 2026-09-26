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

/** One module as seen from one workspace: usable only when on globally AND available through the workspace's package or own choice. */
export interface WorkspaceModule {
  module_id: string;
  module_name: string;
  enabled: boolean;
}

/**
 * Admin view: the global switch, whether the workspace's package includes the module, the workspace's own choice
 * (null = none, follow the package), whether that choice deviates from the package, and the result.
 */
export interface WorkspaceModuleAccess extends WorkspaceModule {
  global_enabled: boolean;
  package_included: boolean;
  workspace_enabled: boolean | null;
  deviates: boolean;
}

export interface AdminWorkspaceModules {
  workspace_id: string;
  workspace_name: string;
  package_id: string;
  package_name: string;
  /** True when an individual choice deviates from the package. */
  customized: boolean;
  modules: WorkspaceModuleAccess[];
}

/** A named set of modules; `is_custom` (Maatwerk) includes none by itself: every module is chosen individually. */
export interface ModulePackage {
  id: string;
  name: string;
  description: string;
  is_custom: boolean;
  sort_order: number;
  module_ids: string[];
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

/**
 * How much a Discovery Run should try to do — every field is optional; the server fills in and
 * clamps anything missing or out of range (see apps/api/src/discovery-run-config.ts — the
 * frontend is never the security boundary). `searchBreadth` is a plain string ("focused" |
 * "standard" | "broad" | "advanced" for the vacancies module today) — the Web App never hardcodes
 * what each tier means, it only offers whatever the domain reports.
 */
export interface DiscoveryRunConfig {
  targetRecords?: number;
  searchBreadth?: string;
  maxPages?: number;
  maxCandidates?: number;
  maxDurationMs?: number;
  maxEnrichments?: number;
  onlyNewRecords?: boolean;
}

/** Vacancy-module-specific search filters — opaque to apps/api, passed straight through to the
 * domain adapter. `sources` only matters for branch mode (which providers to use); a website
 * crawl only ever reads `postedWithinDays`. */
export interface VacancySearchFilters {
  postedWithinDays?: number;
  sources?: string[];
}

/** Body for `runs.startBranchSearch` — the "search by branch" alternative to `runs.start`'s
 * plain `sourceUrl`. `country`, `region` and `keywords` are all optional. `country` is the
 * search country ("Nederland"), `region` a region, province or place inside it ("Zuid-Holland") —
 * geography goes there, not into `keywords`. */
export interface BranchSearchInput {
  branch: string;
  country?: string;
  region?: string;
  keywords?: string;
  runConfig?: DiscoveryRunConfig;
  filters?: VacancySearchFilters;
}

/** Body for `runs.startSourceRun` — a run that pulls from a named API/feed source instead of crawling a website or
 * searching a branch. `sourceId` picks the source; `filters` are that source's own (opaque to the client and to
 * apps/api). */
export interface SourceRunInput {
  sourceId: string;
  filters?: Record<string, unknown>;
  runConfig?: DiscoveryRunConfig;
}

/** The user's hard limits of extended processing (a background job); the API clamps them to its ceilings. */
export interface DiscoveryJobLimits {
  maxCandidates: number;
  batchSize: number;
  pagesPerCompany: number;
  maxSearchQueries: number;
  /** Set by the API: batches started in total, failed ones included. */
  maxBatches?: number;
}

/** Extended processing: one search run in the background as a series of batches (see apps/api/src/jobs/job-runner.ts). */
export interface DiscoveryJob {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed';
  message: string | null;
  limits: Required<DiscoveryJobLimits>;
  usage: {
    batches: number; batchesFailed: number; candidatesResearched: number; searchQueries: number; pagesVisited: number;
    recordsCreated: number; recordsUpdated: number; candidatesRemaining: number | null;
  };
  progress: { candidatesResearched: number; maxCandidates: number; candidatesRemaining: number | null };
  batches: Array<{
    runId: string; status: DiscoveryRun['status']; batch: number; error: string | null; companiesResearched: number;
    recordsCreated: number; recordsUpdated: number; searchQueries: number; createdAt: string; completedAt: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface DiscoveryRun {
  id: string;
  project_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed';
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
