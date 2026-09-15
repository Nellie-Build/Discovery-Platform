import { Pool } from 'pg';

/**
 * The minimal shape every repository in this package actually needs — not `pg`'s own `Pool`/
 * `PoolClient` types directly, so a test can hand repositories anything that queries the same
 * way (a real `pg.Pool`, a single `pg.PoolClient`, or an embedded PGlite instance for fast,
 * no-server-required tests with real Postgres semantics — see tests/*.test.mjs).
 */
export interface QueryResultLike<T> { rows: T[] }
export interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>;
}

/** A database handle capable of running an atomic transaction, one way or another: a real
 * connection pool exposes `connect()` (acquire one dedicated connection, since BEGIN/COMMIT
 * must run on the same connection); a single-connection engine like PGlite exposes its own
 * `transaction()` instead. `withTransaction` below works with either. */
export interface TransactionCapable extends Queryable {
  connect?(): Promise<Queryable & { release(): void }>;
  transaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * `DATABASE_URL` takes precedence (a single connection string, e.g. what a hosted Postgres
 * provider gives you); otherwise falls back to the discrete `POSTGRES_*` variables, matching
 * `.env.example` at the repository root. Neither is Discovery-Platform-specific — any Postgres
 * server works.
 */
export function createPool(): Pool {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  }
  const port = Number(process.env.POSTGRES_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid POSTGRES_PORT.');
  const ssl = process.env.POSTGRES_SSL ?? 'false';
  if (!['true', 'false'].includes(ssl)) throw new Error('POSTGRES_SSL must be true or false.');
  return new Pool({
    host: process.env.POSTGRES_HOST ?? '127.0.0.1', port,
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
    ssl: ssl === 'true' ? { rejectUnauthorized: true } : false,
    max: 5, connectionTimeoutMillis: 10_000,
  });
}

/** Runs `fn` inside a single atomic transaction, rolling back on any error. Nothing this
 * package's repositories write ever happens outside a transaction that could otherwise leave
 * sources/contacts without their record, or a partial run's worth of records committed. */
export async function withTransaction<T>(db: TransactionCapable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(fn);
  if (!db.connect) throw new Error('withTransaction requires a database handle exposing connect() or transaction().');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
