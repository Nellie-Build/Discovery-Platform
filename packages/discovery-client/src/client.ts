import {
  ApiError,
  type PublicUser, type Workspace, type WorkspaceMembership, type Project, type AdminProject,
  type DiscoveryRun, type DiscoveryRecord, type RecordWithDetails, type BranchSearchInput, type SourceRunInput,
  type DiscoveryModuleDefinition, type DiscoveryRunConfig, type VacancySearchFilters,
  type WorkspaceModule, type WorkspaceModuleAccess, type AdminWorkspaceModules,
} from './types.js';

export interface ApiClientOptions {
  /** e.g. "http://127.0.0.1:3000/api/v1" or "/api/v1" behind a same-origin reverse proxy. */
  baseUrl: string;
}

async function request<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    credentials: 'include', // sends/receives the httpOnly session cookie — never a token in localStorage.
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, json?.error ?? 'unknown_error', json?.message ?? `Request failed with status ${response.status}.`);
  }
  return json as T;
}

/**
 * The one place apps/web is allowed to call fetch() against Discovery Platform's API — every
 * screen imports this instead of writing its own request/response handling. Every method
 * throws `ApiError` (never a raw Response) on failure.
 */
export function createApiClient({ baseUrl }: ApiClientOptions) {
  const req = <T>(method: string, path: string, body?: unknown) => request<T>(baseUrl, method, path, body);

  return {
    auth: {
      register: (email: string, password: string) => req<{ user: PublicUser; workspace: Workspace }>('POST', '/auth/register', { email, password }),
      login: (email: string, password: string) => req<PublicUser>('POST', '/auth/login', { email, password }),
      logout: () => req<void>('POST', '/auth/logout'),
      me: () => req<PublicUser>('GET', '/auth/me'),
    },
    workspaces: {
      /** Every workspace the current user belongs to. */
      listMine: () => req<WorkspaceMembership[]>('GET', '/workspaces'),
      get: (id: string) => req<Workspace>('GET', `/workspaces/${id}`),
      create: (name: string) => req<Workspace>('POST', '/workspaces', { name }),
      /** Which modules this workspace may use for new projects and runs (enforced by the API either way). */
      modules: (id: string) => req<WorkspaceModule[]>('GET', `/workspaces/${id}/modules`),
    },
    projects: {
      listByWorkspace: (workspaceId: string) => req<Project[]>('GET', `/projects?workspaceId=${encodeURIComponent(workspaceId)}`),
      get: (id: string) => req<Project>('GET', `/projects/${id}`),
      create: (input: { workspaceId: string; name: string; domain: string; config?: Record<string, unknown> }) =>
        req<Project>('POST', '/projects', input),
      /** Soft delete — see apps/api/src/routes/projects.ts. The project disappears from
       * listByWorkspace/get immediately; its records/runs stay intact. */
      delete: (id: string) => req<void>('DELETE', `/projects/${id}`),
    },
    runs: {
      start: (projectId: string, sourceUrl: string, options: { runConfig?: DiscoveryRunConfig; filters?: VacancySearchFilters } = {}) =>
        req<DiscoveryRun>('POST', `/projects/${projectId}/runs`, { sourceUrl, ...options }),
      /** "Search by branch" mode — a Source Discovery layer in front of the same crawler/
       * extractor `start()` uses, for a project with no single website in mind yet. `region` and
       * `keywords` are both optional. */
      startBranchSearch: (projectId: string, input: BranchSearchInput) => req<DiscoveryRun>('POST', `/projects/${projectId}/runs`, input),
      /** A run against a named source (an API or feed) — no website, no branch. */
      startSourceRun: (projectId: string, input: SourceRunInput) => req<DiscoveryRun>('POST', `/projects/${projectId}/runs`, input),
      listByProject: (projectId: string) => req<DiscoveryRun[]>('GET', `/projects/${projectId}/runs`),
      get: (id: string) => req<DiscoveryRun>('GET', `/runs/${id}`),
    },
    records: {
      listByProject: (projectId: string, options: { domain?: string; runId?: string } = {}) => {
        const params = new URLSearchParams();
        if (options.domain) params.set('domain', options.domain);
        if (options.runId) params.set('runId', options.runId);
        const query = params.size ? `?${params}` : '';
        return req<DiscoveryRecord[]>('GET', `/projects/${projectId}/records${query}`);
      },
      get: (id: string) => req<RecordWithDetails>('GET', `/records/${id}`),
    },
    /** Admin-only — every method 403s for a non-admin user (see apps/api/src/admin-access.ts). */
    admin: {
      modules: {
        list: () => req<DiscoveryModuleDefinition[]>('GET', '/admin/modules'),
        setEnabled: (id: string, enabled: boolean) => req<DiscoveryModuleDefinition>('PATCH', `/admin/modules/${id}`, { enabled }),
      },
      workspaceModules: {
        /** Every workspace with, per module, the global switch, the workspace's own decision and the result. */
        list: () => req<AdminWorkspaceModules[]>('GET', '/admin/workspace-modules'),
        /** `null` clears the workspace's decision: it follows the global switch again. */
        set: (workspaceId: string, moduleId: string, enabled: boolean | null) =>
          req<WorkspaceModuleAccess>('PUT', `/admin/workspaces/${workspaceId}/modules/${moduleId}`, { enabled }),
      },
      projects: {
        /** Every project across every workspace, active and soft-deleted alike. */
        list: () => req<AdminProject[]>('GET', '/admin/projects'),
        restore: (id: string) => req<Project>('POST', `/admin/projects/${id}/restore`),
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
