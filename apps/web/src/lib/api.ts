import { createApiClient } from '@discovery-platform/client';

// The Web App's one and only fetch()-using object — every screen imports `api` from here
// instead of writing its own request handling. See @discovery-platform/client for why: it
// throws ApiError on failure and always sends the session cookie (never a token in localStorage).
export const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000/api/v1',
});
