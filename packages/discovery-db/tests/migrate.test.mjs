import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../dist/migrate.js';

test('runMigrations applies every migration on a clean database and creates every table', async () => {
  const db = new PGlite();
  const { applied } = await runMigrations(db);
  assert.deepEqual(applied, ['001_init', '002_auth', '003_projects_soft_delete', '004_admin_modules', '005_source_registry', '006_run_records', '007_tenders_module', '008_workspace_modules', '009_module_packages', '010_companies_module', '011_discovery_jobs']);

  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  assert.deepEqual(rows.map(r => r.table_name), [
    'discovery_jobs', 'discovery_records', 'discovery_run_records', 'discovery_runs', 'module_package_modules', 'module_packages', 'modules', 'projects',
    'record_contacts', 'record_sources', 'schema_migrations', 'session', 'sources', 'users', 'workspace_members', 'workspace_module_access',
    'workspace_modules', 'workspaces',
  ]);
  await db.close();
});

test('the Module Registry is seeded with vacancies active/enabled and every other module coming_soon/disabled', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows } = await db.query('SELECT id, enabled, status FROM modules ORDER BY id');
  const vacancies = rows.find(r => r.id === 'vacancies');
  assert.equal(vacancies.enabled, true);
  assert.equal(vacancies.status, 'active');
  for (const row of rows) {
    if (row.id === 'vacancies') continue;
    assert.equal(row.enabled, false, `${row.id} must not be enabled yet`);
    // Companies is built (010) but off until an admin enables it: 'disabled', not 'coming_soon'.
    assert.equal(row.status, row.id === 'companies' ? 'disabled' : 'coming_soon', row.id);
  }
  await db.close();
});

test('users.is_admin defaults to false — no account is an admin unless explicitly promoted', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [user] } = await db.query("INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'hash') RETURNING *");
  assert.equal(user.is_admin, false);
  await db.close();
});

test('projects.deleted_at/deleted_by are nullable and default to null (a fresh project is never soft-deleted)', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [workspace] } = await db.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING *', ['W']);
  const { rows: [project] } = await db.query(
    "INSERT INTO projects (workspace_id, name, domain) VALUES ($1, 'P', 'vacancies') RETURNING *", [workspace.id],
  );
  assert.equal(project.deleted_at, null);
  assert.equal(project.deleted_by, null);
  await db.close();
});

test('workspace_members enforces one row per (workspace, user) and a valid role, and cascades on delete', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [workspace] } = await db.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING *', ['W']);
  const { rows: [user] } = await db.query(
    "INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'hash') RETURNING *",
  );
  await db.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspace.id, user.id, 'owner']);

  await assert.rejects(
    db.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspace.id, user.id, 'owner']),
    /duplicate key|unique/i,
  );
  await assert.rejects(
    db.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspace.id, user.id, 'superadmin']),
    /check/i,
  );

  await db.query('DELETE FROM users WHERE id = $1', [user.id]);
  const { rows: remaining } = await db.query('SELECT * FROM workspace_members WHERE workspace_id = $1', [workspace.id]);
  assert.deepEqual(remaining, []);
  await db.close();
});

test('users.email is unique (case-sensitively at the SQL level — the application layer lowercases it, see UsersRepository)', async () => {
  const db = new PGlite();
  await runMigrations(db);
  await db.query("INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'hash')");
  await assert.rejects(
    db.query("INSERT INTO users (email, password_hash) VALUES ('a@example.com', 'hash2')"),
    /duplicate key|unique/i,
  );
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

test('the tenders module is registered but disabled by default, and no tender-specific table or column exists', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [tenders] } = await db.query("SELECT id, name, enabled, status FROM modules WHERE id = 'tenders'");
  assert.equal(tenders.enabled, false);
  assert.equal(tenders.status, 'coming_soon');
  const { rows: tables } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%tender%'");
  assert.deepEqual(tables, []);
  // Running the migrations again keeps the registry row untouched.
  await runMigrations(db);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM modules WHERE id = 'tenders'");
  assert.equal(rows[0].n, 1);
  await db.close();
});
