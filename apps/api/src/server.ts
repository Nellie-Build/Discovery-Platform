import express, { type Express } from 'express';
import { createPool, type TransactionCapable } from '@discovery-platform/db';
import { devApiKeyAuth } from './auth.js';
import { errorHandler } from './http-errors.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { createProjectsRouter } from './routes/projects.js';
import { createRunsRouter } from './routes/runs.js';
import { createRecordsRouter } from './routes/records.js';
import { defaultDomainRegistry, type DomainRegistry } from './domain-registry.js';

const API_PREFIX = '/api/v1';

/**
 * Builds the Express app against a given database handle, without starting a server or reading
 * any environment variable — this is what tests import so they can point the app at a fast
 * PGlite instance instead of a real Postgres server (`pool` only needs to be `TransactionCapable`
 * — a real `pg.Pool` or a PGlite instance both qualify), and optionally at a test-specific
 * domain registry (e.g. a vacancies adapter with a fake crawl transport) instead of the real
 * one. `main()` below is the only place that reads env vars and calls `.listen()`.
 */
export function createApp(
  pool: TransactionCapable,
  options: { apiKey?: string; domainRegistry?: DomainRegistry } = {},
): Express {
  const domainRegistry = options.domainRegistry ?? defaultDomainRegistry;
  const app = express();
  app.use(express.json());

  app.get(`${API_PREFIX}/health`, (_req, res) => res.json({ status: 'ok' }));

  // Every route below this line requires the dev API key, if one is configured (see auth.ts) —
  // health check stays open for infra probes either way.
  app.use(API_PREFIX, devApiKeyAuth(options.apiKey));
  app.use(API_PREFIX, createWorkspacesRouter(pool));
  app.use(API_PREFIX, createProjectsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRunsRouter(pool, domainRegistry));
  app.use(API_PREFIX, createRecordsRouter(pool));

  app.use(errorHandler);
  return app;
}

async function main() {
  const pool = createPool();
  const app = createApp(pool, { apiKey: process.env.API_DEV_KEY || undefined });
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
