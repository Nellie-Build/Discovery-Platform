import path from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import { createPool, type TransactionCapable } from '@discovery-platform/db';
import { configurePassport } from './auth/passport.js';
import { createSessionMiddleware } from './auth/session.js';
import { createAuthRouter } from './auth/routes.js';
import { createDevAuthBypass, devAuthBypassEnabled } from './auth/dev-bypass.js';
import { authenticate } from './workspace-access.js';
import { errorHandler } from './http-errors.js';
import { requestLogger } from './logging.js';
import { authRateLimiter, runsRateLimiter } from './rate-limit.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { createProjectsRouter } from './routes/projects.js';
import { createRunsRouter } from './routes/runs.js';
import { createRecordsRouter } from './routes/records.js';
import { createAdminRouter } from './routes/admin.js';
import { defaultDomainRegistry, type DomainRegistry } from './domain-registry.js';

const API_PREFIX = '/api/v1';

export interface CreateAppOptions {
  /** The shared development API key from fase 2.1 — local scripts/tests only, never real Web
   * App auth (see workspace-access.ts). Unset in a real deployment. */
  apiKey?: string;
  /** Existing local account only; runtime environment and loopback checks remain mandatory. */
  devAuthEmail?: string;
  domainRegistry?: DomainRegistry;
  /** Signs the session cookie — see auth/session.ts. Required; there is no insecure default in
   * production (see main() below). */
  sessionSecret: string;
  /** Only the Web App's own origin may send credentialed (cookie-carrying) cross-origin
   * requests — anyone else's browser gets no CORS headers at all, regardless of the request's
   * own Origin header, since Express's cors() only reflects an *allowed* origin back. Same-origin
   * requests (the production deployment, once webDistDir is set) never depend on this at all —
   * browsers don't apply CORS to a same-origin request in the first place. */
  webOrigin: string;
  /** HTTPS-only cookies — true in production, false for local HTTP development. */
  secureCookies?: boolean;
  /** Basic per-IP rate limiting on login/register/start-a-run — off by default (see
   * rate-limit.ts's own doc comment for why); main() turns it on for the real server. */
  rateLimiting?: boolean;
  /** When set, this Express process also serves the built Web App as static files and falls
   * back to its index.html for any non-API GET route — the single-origin setup fase 2.3 asks
   * for, so the session cookie is always first-party. Left unset, apps/api serves only the API,
   * exactly as before (local development keeps running Vite and the API separately). */
  webDistDir?: string;
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
  // Cloud Run (and any reverse proxy) terminates HTTPS in front of this process — trusting its
  // one hop is what lets express-session see the request as secure and req.ip see the real
  // client, not the proxy, both required for correct "secure cookie" and rate-limiting behavior.
  app.set('trust proxy', 1);
  app.use(requestLogger());
  app.use(cors({ origin: options.webOrigin, credentials: true }));
  app.use(express.json());
  app.use(createSessionMiddleware(pool, { secret: options.sessionSecret, secure: options.secureCookies ?? false }));
  const passport = configurePassport(pool);
  app.use(passport.initialize());
  app.use(passport.session());
  if (options.devAuthEmail) app.use(API_PREFIX, createDevAuthBypass(pool, options.devAuthEmail));

  app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ status: 'ok' }));

  if (options.rateLimiting) {
    app.use(`${API_PREFIX}/auth/login`, authRateLimiter);
    app.use(`${API_PREFIX}/auth/register`, authRateLimiter);
  }
  // register/login manage their own auth state; logout/me each check req.isAuthenticated()
  // themselves — none of the four needs to already be authenticated to be reachable.
  app.use(API_PREFIX, createAuthRouter(pool, passport));

  // Every route below this line requires either a logged-in session or the dev API key (see
  // workspace-access.ts) — health and /auth/* above stay reachable either way.
  app.use(API_PREFIX, authenticate(options.apiKey));
  if (options.rateLimiting) app.use(`${API_PREFIX}/projects/:id/runs`, runsRateLimiter);
  app.use(API_PREFIX, createWorkspacesRouter(pool));
  app.use(API_PREFIX, createProjectsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRunsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRecordsRouter(pool));
  app.use(API_PREFIX, createAdminRouter(pool));
  // Nothing under /api/v1 matched — a clean JSON 404, never the SPA fallback below.
  app.use(API_PREFIX, (_req, res) => { res.status(404).json({ error: 'not_found', message: 'Route not found.' }); });

  if (options.webDistDir) {
    app.use(express.static(options.webDistDir));
    app.get('*', (_req, res) => res.sendFile(path.join(options.webDistDir!, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

const PLACEHOLDER_SESSION_SECRETS = new Set(['replace-with-a-long-random-value', 'test-session-secret-not-for-production']);

/** Every startup check below is deliberate: a production deployment must fail loudly and
 * immediately on a missing or weak secret, never start up and silently run with one — see fase
 * 2.3's brief ("productie mag nooit stilletjes terugvallen op een zwakke/default
 * SESSION_SECRET" / "bij ontbrekende verplichte secrets: fail fast tijdens startup"). */
function assertProductionReady(): void {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required — see .env.example.');
  if (sessionSecret.length < 32 || PLACEHOLDER_SESSION_SECRETS.has(sessionSecret)) {
    throw new Error(
      'SESSION_SECRET is too short or looks like a placeholder/example value. Production requires ' +
      'a real, unique, long random value (e.g. `openssl rand -hex 32`) — refusing to start.',
    );
  }
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const hasDiscretePostgresConfig = Boolean(
    process.env.POSTGRES_HOST && process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD && process.env.POSTGRES_DB,
  );
  if (!hasDatabaseUrl && !hasDiscretePostgresConfig) {
    throw new Error('DATABASE_URL (or POSTGRES_HOST/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB) is required — refusing to start.');
  }
  if (process.env.API_DEV_KEY && process.env.ALLOW_DEV_API_KEY_IN_PRODUCTION !== '1') {
    throw new Error(
      'API_DEV_KEY is set but ALLOW_DEV_API_KEY_IN_PRODUCTION=1 is not — the development API key must never ' +
      'authenticate the real Web App. Unset API_DEV_KEY, or set ALLOW_DEV_API_KEY_IN_PRODUCTION=1 if this is ' +
      'deliberate (local/technical testing against a deployed environment only).',
    );
  }
}

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) assertProductionReady();
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('SESSION_SECRET is required — see .env.example.');
  const pool = createPool();
  const bypass = devAuthBypassEnabled(process.env);
  if (bypass && !process.env.DEV_AUTH_EMAIL) throw new Error('DEV_AUTH_EMAIL must identify an existing local account.');
  const app = createApp(pool, {
    devAuthEmail: bypass ? process.env.DEV_AUTH_EMAIL : undefined,
    apiKey: process.env.API_DEV_KEY || undefined,
    sessionSecret,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    secureCookies: isProduction,
    rateLimiting: isProduction,
    webDistDir: process.env.WEB_DIST_DIR || undefined,
  });
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? '3000');
  app.listen(port, bypass ? '127.0.0.1' : '::', () => {
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
