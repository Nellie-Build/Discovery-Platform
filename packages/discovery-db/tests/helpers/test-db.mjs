import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../../dist/migrate.js';

/** A fresh, in-process, real-Postgres-semantics database for one test — no external server
 * needed. Every test that needs a schema calls this once and gets total isolation from every
 * other test, since each PGlite instance is its own separate database. */
export async function freshDb() {
  const db = new PGlite();
  await runMigrations(db);
  return db;
}
