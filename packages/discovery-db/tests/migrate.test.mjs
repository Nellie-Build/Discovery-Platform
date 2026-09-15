import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../dist/migrate.js';

test('runMigrations applies 001_init on a clean database and creates every table', async () => {
  const db = new PGlite();
  const { applied } = await runMigrations(db);
  assert.deepEqual(applied, ['001_init']);

  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  assert.deepEqual(rows.map(r => r.table_name), [
    'discovery_records', 'discovery_runs', 'projects', 'record_contacts', 'record_sources', 'schema_migrations', 'workspaces',
  ]);
  await db.close();
});

test('runMigrations is idempotent: a second run against an already-migrated database applies nothing', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { applied } = await runMigrations(db);
  assert.deepEqual(applied, []);
  await db.close();
});

test('the generic schema has no domain-specific column anywhere — every domain fact lives in JSONB', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows } = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('discovery_records', 'projects')`,
  );
  const forbidden = ['salary', 'bedrooms', 'bathrooms', 'company_name', 'skills', 'vacancy_title'];
  for (const row of rows) {
    assert.ok(!forbidden.includes(row.column_name), `unexpected domain-specific column ${row.table_name}.${row.column_name}`);
  }
  // domain_data/config/classification/stats are exactly where domain facts belong.
  const jsonbColumns = rows.filter(r => ['domain_data', 'config', 'classification'].includes(r.column_name));
  assert.ok(jsonbColumns.length >= 2);
  await db.close();
});

test('foreign keys cascade: deleting a workspace removes its projects, runs and records', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [workspace] } = await db.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING *', ['Test workspace']);
  const { rows: [project] } = await db.query(
    "INSERT INTO projects (workspace_id, name, domain) VALUES ($1, 'Test project', 'vacancies') RETURNING *",
    [workspace.id],
  );
  await db.query("INSERT INTO discovery_runs (project_id, status) VALUES ($1, 'succeeded')", [project.id]);
  const { rows: [record] } = await db.query(
    "INSERT INTO discovery_records (project_id, domain) VALUES ($1, 'vacancies') RETURNING *", [project.id],
  );
  await db.query("INSERT INTO record_sources (record_id, source_type) VALUES ($1, 'website')", [record.id]);

  await db.query('DELETE FROM workspaces WHERE id = $1', [workspace.id]);

  const { rows: remainingProjects } = await db.query('SELECT * FROM projects WHERE workspace_id = $1', [workspace.id]);
  const { rows: remainingRecords } = await db.query('SELECT * FROM discovery_records WHERE project_id = $1', [project.id]);
  assert.deepEqual(remainingProjects, []);
  assert.deepEqual(remainingRecords, []);
  await db.close();
});
