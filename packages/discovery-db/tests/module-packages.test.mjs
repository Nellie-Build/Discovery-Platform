import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../dist/migrate.js';
import { ModulesRepository, withTransaction } from '../dist/index.js';

/**
 * 009_module_packages on a database that already has workspaces: every workspace keeps exactly its effective module
 * access (the 008 rule: global AND COALESCE(workspace choice, true)), gets the matching package, keeps its individual
 * choices, and no module is switched on. The runner skips versions listed in schema_migrations, so 009 is held back
 * by listing it first, the pre-009 situation is built, and then 009 alone is applied.
 */
const ACCESS_008 = `SELECT w.name, m.id AS module_id, (m.enabled AND COALESCE(wm.enabled, true)) AS enabled
  FROM workspaces w CROSS JOIN modules m LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = m.id ORDER BY w.name, m.id`;

async function databaseBefore009() {
  const db = new PGlite();
  await db.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await db.query("INSERT INTO schema_migrations (version) VALUES ('009_module_packages')");
  await runMigrations(db);
  await db.query("UPDATE modules SET enabled = true WHERE id = 'tenders'");
  const workspaces = {};
  for (const name of ['beide', 'alleen-vacancies', 'alleen-tenders', 'geen', 'tenders-uit', 'extra-module']) {
    workspaces[name] = (await db.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  }
  const choice = (name, module, enabled) => db.query('INSERT INTO workspace_modules (workspace_id, module_id, enabled) VALUES ($1, $2, $3)', [workspaces[name], module, enabled]);
  await choice('alleen-vacancies', 'vacancies', true);
  await choice('alleen-vacancies', 'tenders', false);
  await choice('alleen-tenders', 'vacancies', false);
  await choice('geen', 'vacancies', false);
  await choice('geen', 'tenders', false);
  await choice('tenders-uit', 'tenders', false);
  await choice('extra-module', 'companies', true);
  const project = (await db.query("INSERT INTO projects (workspace_id, name, domain) VALUES ($1, 'P', 'tenders') RETURNING id", [workspaces['alleen-vacancies']])).rows[0].id;
  await db.query("INSERT INTO discovery_records (project_id, domain, display_name) VALUES ($1, 'tenders', 'Historisch')", [project]);
  await db.query("INSERT INTO discovery_runs (project_id, status) VALUES ($1, 'succeeded')", [project]);
  return { db, workspaces };
}
const apply009 = async db => {
  await db.query("DELETE FROM schema_migrations WHERE version = '009_module_packages'");
  return runMigrations(db);
};

test('009 keeps every existing workspace\'s effective access, picks the matching package and keeps individual choices', async () => {
  const { db } = await databaseBefore009();
  const before = (await db.query(ACCESS_008)).rows;
  const choicesBefore = (await db.query('SELECT workspace_id, module_id, enabled FROM workspace_modules ORDER BY 1, 2')).rows;
  assert.deepEqual((await apply009(db)).applied, ['009_module_packages']);

  const after = (await db.query(`SELECT w.name, a.module_id, a.enabled FROM workspace_module_access a JOIN workspaces w ON w.id = a.workspace_id ORDER BY w.name, a.module_id`)).rows;
  assert.deepEqual(after, before);
  const packages = Object.fromEntries((await db.query('SELECT name, module_package_id FROM workspaces')).rows.map(r => [r.name, r.module_package_id]));
  assert.deepEqual(packages, { beide: 'complete', 'alleen-vacancies': 'vacancies', 'alleen-tenders': 'tenders', geen: 'custom', 'tenders-uit': 'vacancies', 'extra-module': 'complete' });
  assert.deepEqual((await db.query('SELECT workspace_id, module_id, enabled FROM workspace_modules ORDER BY 1, 2')).rows, choicesBefore, 'individual choices kept, none added');
  const counts = (await db.query('SELECT (SELECT count(*)::int FROM projects) p, (SELECT count(*)::int FROM discovery_records) r, (SELECT count(*)::int FROM discovery_runs) x')).rows[0];
  assert.deepEqual(counts, { p: 1, r: 1, x: 1 });
  await db.close();
});

test('009 never loses access to a globally enabled module outside every package: it becomes an explicit choice', async () => {
  const { db, workspaces } = await databaseBefore009();
  await db.query("UPDATE modules SET enabled = true WHERE id = 'housing'");
  const before = (await db.query(ACCESS_008)).rows;
  await apply009(db);
  const after = (await db.query(`SELECT w.name, a.module_id, a.enabled FROM workspace_module_access a JOIN workspaces w ON w.id = a.workspace_id ORDER BY w.name, a.module_id`)).rows;
  assert.deepEqual(after, before);
  const housing = (await db.query("SELECT enabled FROM workspace_modules WHERE workspace_id = $1 AND module_id = 'housing'", [workspaces.beide])).rows;
  assert.deepEqual(housing, [{ enabled: true }]);
  const blocked = (await db.query("SELECT count(*)::int n FROM workspace_modules WHERE workspace_id = $1 AND module_id = 'housing'", [workspaces.geen])).rows[0].n;
  assert.equal(blocked, 1, 'every workspace that had housing keeps it explicitly');
  await db.close();
});

test('packages: definitions, a new workspace gets Compleet, the global switch wins, deviations are marked, switching resets or keeps', async () => {
  const db = new PGlite();
  await runMigrations(db);
  await db.query("UPDATE modules SET enabled = true WHERE id = 'tenders'");
  const repo = new ModulesRepository(db);
  const packages = await repo.listPackages();
  assert.deepEqual(packages.map(p => [p.id, p.name, p.is_custom, p.module_ids]), [
    ['vacancies', 'Vacancies', false, ['vacancies']], ['tenders', 'Tenders', false, ['tenders']],
    ['complete', 'Compleet', false, ['tenders', 'vacancies']], ['custom', 'Maatwerk', true, []],
  ]);
  const ws = (await db.query("INSERT INTO workspaces (name) VALUES ('nieuw') RETURNING id, module_package_id")).rows[0];
  assert.equal(ws.module_package_id, 'complete');
  const access = async () => Object.fromEntries((await repo.listWorkspaceAccess(ws.id)).filter(a => ['vacancies', 'tenders'].includes(a.module_id)).map(a => [a.module_id, a.enabled]));
  const setPackage = id => withTransaction(db, tx => new ModulesRepository(tx).setWorkspacePackage(ws.id, id, null));

  assert.deepEqual(await access(), { tenders: true, vacancies: true });
  for (const [id, expected] of [['vacancies', { tenders: false, vacancies: true }], ['tenders', { tenders: true, vacancies: false }], ['complete', { tenders: true, vacancies: true }]]) {
    assert.equal(await setPackage(id), true);
    assert.deepEqual(await access(), expected, id);
  }
  assert.equal(await setPackage('bestaat-niet'), false);

  await repo.setWorkspaceEnabled(ws.id, 'tenders', false, null);
  const tenders = (await repo.listWorkspaceAccess(ws.id)).find(a => a.module_id === 'tenders');
  assert.deepEqual({ included: tenders.package_included, choice: tenders.workspace_enabled, deviates: tenders.deviates, enabled: tenders.enabled }, { included: true, choice: false, deviates: true, enabled: false });

  // To Maatwerk: what the workspace has stays, every module now an individual choice (no deviation in a custom package).
  await setPackage('custom');
  assert.deepEqual(await access(), { tenders: false, vacancies: true });
  assert.ok((await repo.listWorkspaceAccess(ws.id)).every(a => a.workspace_enabled !== null && !a.deviates));
  // Back to a regular package: starts clean from the package.
  await setPackage('tenders');
  assert.deepEqual(await access(), { tenders: true, vacancies: false });
  assert.equal((await db.query('SELECT count(*)::int n FROM workspace_modules WHERE workspace_id = $1', [ws.id])).rows[0].n, 0);

  // The global switch wins over package and individual choice.
  await repo.setWorkspaceEnabled(ws.id, 'tenders', true, null);
  await repo.setEnabled('tenders', false);
  assert.deepEqual(await access(), { tenders: false, vacancies: false });
  await db.close();
});

test('010: companies is described and built, stays off globally, and is in no package', async () => {
  const db = new PGlite();
  await runMigrations(db);
  const { rows: [companies] } = await db.query("SELECT enabled, status, capabilities, description FROM modules WHERE id = 'companies'");
  assert.deepEqual([companies.enabled, companies.status, companies.capabilities], [false, 'disabled', ['web_search', 'website']]);
  assert.match(companies.description, /afnemerssector/);
  assert.deepEqual((await db.query("SELECT package_id FROM module_package_modules WHERE module_id = 'companies'")).rows, []);
  const ws = (await db.query("INSERT INTO workspaces (name) VALUES ('nieuw') RETURNING id")).rows[0];
  await db.query("UPDATE modules SET enabled = true WHERE id = 'companies'");
  const access = (await db.query("SELECT enabled FROM workspace_module_access WHERE workspace_id = $1 AND module_id = 'companies'", [ws.id])).rows[0];
  assert.equal(access.enabled, false, 'globally on is not enough: a Compleet workspace does not get companies');
  await db.close();
});
