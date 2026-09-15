import {
  ApiError,
  type PublicUser, type Workspace, type WorkspaceMembership, type Project,
  type DiscoveryRun, type DiscoveryRecord, type RecordWithDetails,
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
    },
    projects: {
      listByWorkspace: (workspaceId: string) => req<Project[]>('GET', `/projects?workspaceId=${encodeURIComponent(workspaceId)}`),
      get: (id: string) => req<Project>('GET', `/projects/${id}`),
      create: (input: { workspaceId: string; name: string; domain: string; config?: Record<string, unknown> }) =>
        req<Project>('POST', '/projects', input),
    },
    runs: {
      start: (projectId: string, sourceUrl: string) => req<DiscoveryRun>('POST', `/projects/${projectId}/runs`, { sourceUrl }),
      listByProject: (projectId: string) => req<DiscoveryRun[]>('GET', `/projects/${projectId}/runs`),
      get: (id: string) => req<DiscoveryRun>('GET', `/runs/${id}`),
    },
    records: {
      listByProject: (projectId: string, options: { domain?: string } = {}) => {
        const query = options.domain ? `?domain=${encodeURIComponent(options.domain)}` : '';
        return req<DiscoveryRecord[]>('GET', `/projects/${projectId}/records${query}`);
      },
      get: (id: string) => req<RecordWithDetails>('GET', `/records/${id}`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
