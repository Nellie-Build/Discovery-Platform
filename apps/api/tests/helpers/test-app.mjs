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

/**
 * Spins up the whole API — a fresh, isolated PGlite database (migrated), and the Express app
 * listening on a real ephemeral port — for one test. `pages` (if given) becomes the fake
 * website the vacancies adapter "crawls" when a test POSTs to /projects/:id/runs; no real
 * network access happens anywhere in this test suite.
 */
export async function startTestApp({ pages, apiKey } = {}) {
  const db = new PGlite();
  await runMigrations(db);

  const domainRegistry = pages
    ? { vacancies: createVacanciesAdapter({ transport: fakeSite(pages), clock: fakeClock() }) }
    : undefined;
  const app = createApp(db, { apiKey, domainRegistry });

  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  async function request(method, path, { body, headers } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }

  return { request, close, db };
}
