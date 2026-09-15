import express, { type Express } from 'express';
import cors from 'cors';
import { createPool, type TransactionCapable } from '@discovery-platform/db';
import { configurePassport } from './auth/passport.js';
import { createSessionMiddleware } from './auth/session.js';
import { createAuthRouter } from './auth/routes.js';
import { authenticate } from './workspace-access.js';
import { errorHandler } from './http-errors.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { createProjectsRouter } from './routes/projects.js';
import { createRunsRouter } from './routes/runs.js';
import { createRecordsRouter } from './routes/records.js';
import { defaultDomainRegistry, type DomainRegistry } from './domain-registry.js';

const API_PREFIX = '/api/v1';

export interface CreateAppOptions {
  /** The shared development API key from fase 2.1 — local scripts/tests only, never real Web
   * App auth (see workspace-access.ts). Unset in a real deployment. */
  apiKey?: string;
  domainRegistry?: DomainRegistry;
  /** Signs the session cookie — see auth/session.ts. Required; there is no insecure default in
   * production (see main() below). */
  sessionSecret: string;
  /** Only the Web App's own origin may send credentialed (cookie-carrying) cross-origin
   * requests — anyone else's browser gets no CORS headers at all, regardless of the request's
   * own Origin header, since Express's cors() only reflects an *allowed* origin back. */
  webOrigin: string;
  /** HTTPS-only cookies — true in production, false for local HTTP development. */
  secureCookies?: boolean;
}

/**
 * Builds the Express app against a given database handle, without starting a server or reading
 * any environment variable — this is what tests import so they can point the app at a fast
 * PGlite instance instead of a real Postgres server (`pool` only needs to be `TransactionCapable`
 * — a real `pg.Pool` or a PGlite instance both qualify), and optionally at a test-specific
 * domain registry (e.g. a vacancies adapter with a fake crawl transport) instead of the real
 * one. `main()` below is the only place that reads env vars and calls `.listen()`.
 */
export function createApp(pool: TransactionCapable, options: CreateAppOptions): Express {
  const domainRegistry = options.domainRegistry ?? defaultDomainRegistry;
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: options.webOrigin, credentials: true }));
  app.use(express.json());
  app.use(createSessionMiddleware(pool, { secret: options.sessionSecret, secure: options.secureCookies ?? false }));
  const passport = configurePassport(pool);
  app.use(passport.initialize());
  app.use(passport.session());

  app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ status: 'ok' }));

  // register/login manage their own auth state; logout/me each check req.isAuthenticated()
  // themselves — none of the four needs to already be authenticated to be reachable.
  app.use(API_PREFIX, createAuthRouter(pool, passport));

  // Every route below this line requires either a logged-in session or the dev API key (see
  // workspace-access.ts) — health and /auth/* above stay reachable either way.
  app.use(API_PREFIX, authenticate(options.apiKey));
  app.use(API_PREFIX, createWorkspacesRouter(pool));
  app.use(API_PREFIX, createProjectsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRunsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRecordsRouter(pool));

  app.use(errorHandler);
  return app;
}

async function main() {
  const pool = createPool();
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required — see .env.example.');
  const app = createApp(pool, {
    apiKey: process.env.API_DEV_KEY || undefined,
    sessionSecret,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    secureCookies: process.env.NODE_ENV === 'production',
  });
  const port = Number(process.env.API_PORT ?? '3000');
  app.listen(port, () => {
    console.log(`Discovery Platform API listening on http://127.0.0.1:${port}${API_PREFIX}`);
  });
}

// Only run the server when this file is executed directly, not when imported (e.g. by tests).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Failed to start API:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
