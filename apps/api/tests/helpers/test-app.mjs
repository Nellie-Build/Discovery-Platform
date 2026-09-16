import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '@discovery-platform/db';
import { createApp } from '../../dist/server.js';
import { createVacanciesAdapter } from '../../dist/domains/vacancies-adapter.js';

function html(links) {
  return `<html><head><title>T</title></head><body>${links.map(([href, label = 'link']) => `<a href="${href}">${label}</a>`).join('')}</body></html>`;
}
export { html };

/** The exact same "fake site" transport pattern domains/vacancies's own crawler tests use — no
 * real network access, no real DNS/sockets (which discovery-core's own SSRF guard would refuse
 * for a local address anyway). `pages` maps a path to `{ status?, contentType?, body? }`. */
export function fakeSite(pages) {
  return async url => {
    const page = pages[new URL(url).pathname];
    if (!page) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') };
    return { status: page.status ?? 200, headers: { 'content-type': page.contentType ?? 'text/html' }, body: Buffer.from(page.body ?? html([])) };
  };
}
export function fakeClock(startAt = 0) {
  let now = startAt;
  return { now: () => now, sleep: async ms => { now += ms; } };
}

/** The default job-board provider every test gets unless it explicitly injects its own — an
 * empty result, so no test that never meant to exercise branch/job-board behavior can ever
 * accidentally call the real ts-jobspy package (no live Indeed/LinkedIn requests in this suite). */
function emptyJobBoardProvider() {
  return {
    async findCandidates() {
      return {
        candidates: [],
        meta: [
          { provider: 'ts-jobspy', site: 'indeed', status: 'empty', candidates: 0, durationMs: 1, error: null },
          { provider: 'ts-jobspy', site: 'linkedin', status: 'empty', candidates: 0, durationMs: 1, error: null },
        ],
      };
    },
  };
}

let emailCounter = 0;
export function uniqueEmail() {
  emailCounter += 1;
  return `test-user-${emailCounter}-${Date.now()}@example.com`;
}

/**
 * Spins up the whole API — a fresh, isolated PGlite database (migrated), and the Express app
 * listening on a real ephemeral port — for one test. `pages` (if given) becomes the fake
 * website the vacancies adapter "crawls" when a test POSTs to /projects/:id/runs; no real
 * network access happens anywhere in this test suite.
 *
 * `createClient()` returns an independent cookie jar + request function against the *same*
 * running server, so a test can simulate two different logged-in users (or one anonymous
 * caller) at once — exactly what the workspace-isolation tests need.
 */
export async function startTestApp({ pages, apiKey, searchProvider, jobBoardProvider } = {}) {
  const db = new PGlite();
  await runMigrations(db);

  const domainRegistry = pages
    ? { vacancies: createVacanciesAdapter({ transport: fakeSite(pages), clock: fakeClock(), searchProvider, jobBoardProvider: jobBoardProvider ?? emptyJobBoardProvider() }) }
    : undefined;
  const app = createApp(db, {
    apiKey, domainRegistry,
    sessionSecret: 'test-session-secret-not-for-production',
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
  });

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  function createClient(defaultHeaders = {}) {
    let cookie = null;
    async function request(method, path, { body, headers } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...defaultHeaders, ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    async function registerAndLogin(email, password = 'a-secure-password-123') {
      const res = await request('POST', '/auth/register', { body: { email, password } });
      if (res.status !== 201) throw new Error(`registerAndLogin failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    }
    return { request, registerAndLogin };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }

  // When a test starts the app with a dev API key (fase 2.1's original testing bypass — see
  // workspace-access.ts), the default client sends it automatically, matching how those
  // pre-existing tests were written before per-workspace auth existed.
  const anonymous = createClient(apiKey ? { 'x-api-key': apiKey } : {});
  return { request: anonymous.request, registerAndLogin: anonymous.registerAndLogin, createClient, close, db };
}
