import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPool, withTransaction, type TransactionCapable, type Queryable } from './connection.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function listMigrationFiles(): { version: string; file: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => ({ version: name.replace(/\.sql$/, ''), file: path.join(MIGRATIONS_DIR, name) }));
}

/**
 * Applies every migration under migrations/ that has not run yet, in filename order, each in
 * its own transaction. Safe to run repeatedly (a fresh database, or one already fully migrated)
 * — already-applied versions are skipped, tracked in `schema_migrations`. Works against a real
 * `pg.Pool` (production, and the local/CI Postgres) or a PGlite instance (tests) — anything
 * `TransactionCapable` (see connection.ts).
 */
export async function runMigrations(db: TransactionCapable): Promise<{ applied: string[] }> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const alreadyApplied = new Set(rows.map(r => r.version));

  const applied: string[] = [];
  for (const { version, file } of listMigrationFiles()) {
    if (alreadyApplied.has(version)) continue;
    const sql = readFileSync(file, 'utf8');
    try {
      await withTransaction(db, async tx => {
        // A migration file is typically several statements in one string (several CREATE
        // TABLE/INDEX). A real `pg` client's query() already runs a multi-statement string
        // fine; PGlite (used in this package's own tests) needs its separate exec() for that —
        // it has no `pg`-style multi-statement query().
        const runner = tx as Queryable & { exec?(sql: string): Promise<unknown> };
        if (runner.exec) await runner.exec(sql); else await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      });
      applied.push(version);
    } catch (error) {
      throw new Error(`Migration ${version} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { applied };
}

async function main() {
  const pool = createPool();
  try {
    const { applied } = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  } finally {
    await pool.end();
  }
}

// Only run the CLI when this file is executed directly, not when imported (e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
