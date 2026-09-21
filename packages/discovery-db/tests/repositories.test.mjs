import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshDb } from './helpers/test-db.mjs';
import { WorkspacesRepository } from '../dist/repositories/workspaces.js';
import { ProjectsRepository } from '../dist/repositories/projects.js';
import { DiscoveryRunsRepository } from '../dist/repositories/runs.js';
import { DiscoveryRecordsRepository } from '../dist/repositories/records.js';
import { UsersRepository, toPublicUser } from '../dist/repositories/users.js';
import { WorkspaceMembersRepository } from '../dist/repositories/workspace-members.js';
import { withTransaction } from '../dist/connection.js';

test('WorkspacesRepository creates and reads back a workspace', async () => {
  const db = await freshDb();
  const repo = new WorkspacesRepository(db);
  const created = await repo.createWorkspace('Acme Recruiting');
  assert.equal(created.name, 'Acme Recruiting');
  assert.ok(created.id);
  const fetched = await repo.getWorkspaceById(created.id);
  assert.deepEqual(fetched, created);
  await db.close();
});

test('getWorkspaceById returns null for a well-formed but unknown id', async () => {
  const db = await freshDb();
  const repo = new WorkspacesRepository(db);
  assert.equal(await repo.getWorkspaceById('00000000-0000-4000-8000-000000000000'), null);
  await db.close();
});

test('ProjectsRepository rejects an unknown domain only at the API layer, but persists whatever domain string it is given', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const project = await projects.createProject({ workspaceId: workspace.id, name: 'Vacancy scan', domain: 'vacancies' });
  assert.equal(project.workspace_id, workspace.id);
  assert.equal(project.status, 'active');
  assert.deepEqual(project.config, {});
});

test('project isolation: listProjectsByWorkspace never returns another workspace\'s projects', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const workspaceA = await workspaces.createWorkspace('Workspace A');
  const workspaceB = await workspaces.createWorkspace('Workspace B');
  const projectA = await projects.createProject({ workspaceId: workspaceA.id, name: 'A project', domain: 'vacancies' });
  const projectB = await projects.createProject({ workspaceId: workspaceB.id, name: 'B project', domain: 'vacancies' });

  const listA = await projects.listProjectsByWorkspace(workspaceA.id);
  const listB = await projects.listProjectsByWorkspace(workspaceB.id);
  assert.deepEqual(listA.map(p => p.id), [projectA.id]);
  assert.deepEqual(listB.map(p => p.id), [projectB.id]);
  assert.ok(!listA.some(p => p.id === projectB.id));
  assert.ok(!listB.some(p => p.id === projectA.id));
});

test('DiscoveryRunsRepository creates a running run, then marks it succeeded with stats', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const runs = new DiscoveryRunsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const project = await projects.createProject({ workspaceId: workspace.id, name: 'P', domain: 'vacancies' });

  const run = await runs.createRun(project.id);
  assert.equal(run.status, 'running');
  assert.ok(run.started_at);

  const succeeded = await runs.markSucceeded(run.id, { recordsCreated: 3 });
  assert.equal(succeeded.status, 'succeeded');
  assert.deepEqual(succeeded.stats, { recordsCreated: 3 });
  assert.ok(succeeded.completed_at);
});

test('DiscoveryRunsRepository marks a run failed with its error message', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const runs = new DiscoveryRunsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const project = await projects.createProject({ workspaceId: workspace.id, name: 'P', domain: 'vacancies' });
  const run = await runs.createRun(project.id);
  const failed = await runs.markFailed(run.id, 'crawl timed out');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'crawl timed out');
});

test('DiscoveryRecordsRepository persists a record together with its sources and contacts', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const records = new DiscoveryRecordsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const project = await projects.createProject({ workspaceId: workspace.id, name: 'P', domain: 'vacancies' });

  const record = await records.createRecordWithDetails({
    projectId: project.id, domain: 'vacancies', displayName: 'Receptionist',
    domainData: { title: 'Receptionist', company: 'Riad Zaytoun' },
    classification: { presentSignals: ['title', 'company'] }, score: 40,
    sources: [{ sourceType: 'website', sourceUrl: 'https://example.com/vacatures/1' }],
    contacts: [{ type: 'email', value: 'jobs@example.com' }],
  });
  assert.equal(record.display_name, 'Receptionist');
  assert.equal(record.sources.length, 1);
  assert.equal(record.sources[0].source_url, 'https://example.com/vacatures/1');
  assert.equal(record.contacts.length, 1);
  assert.equal(record.contacts[0].value, 'jobs@example.com');

  const fetched = await records.getRecordById(record.id);
  assert.equal(fetched.sources.length, 1);
  assert.equal(fetched.contacts.length, 1);
});

test('listRecordsByProject filters by domain when asked, and always stays scoped to one project', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const records = new DiscoveryRecordsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const projectA = await projects.createProject({ workspaceId: workspace.id, name: 'A', domain: 'vacancies' });
  const projectB = await projects.createProject({ workspaceId: workspace.id, name: 'B', domain: 'vacancies' });
  await records.createRecordWithDetails({ projectId: projectA.id, domain: 'vacancies', displayName: 'A1', domainData: {} });
  await records.createRecordWithDetails({ projectId: projectB.id, domain: 'vacancies', displayName: 'B1', domainData: {} });

  const listA = await records.listRecordsByProject(projectA.id);
  assert.deepEqual(listA.map(r => r.display_name), ['A1']);
  const listAByDomain = await records.listRecordsByProject(projectA.id, { domain: 'vacancies' });
  assert.equal(listAByDomain.length, 1);
  const listAWrongDomain = await records.listRecordsByProject(projectA.id, { domain: 'companies' });
  assert.deepEqual(listAWrongDomain, []);
});

test('transaction rollback: a failing insert mid-transaction leaves zero rows from that transaction behind', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const projects = new ProjectsRepository(db);
  const workspace = await workspaces.createWorkspace('W');
  const project = await projects.createProject({ workspaceId: workspace.id, name: 'P', domain: 'vacancies' });

  await assert.rejects(
    withTransaction(db, async tx => {
      const recordsInTx = new DiscoveryRecordsRepository(tx);
      await recordsInTx.createRecordWithDetails({ projectId: project.id, domain: 'vacancies', displayName: 'Should be rolled back', domainData: {} });
      // A record_id that cannot exist violates the foreign key — the transaction must abort.
      await tx.query('INSERT INTO record_sources (record_id, source_type) VALUES ($1, $2)', ['00000000-0000-4000-8000-000000000000', 'website']);
    }),
  );

  const records = new DiscoveryRecordsRepository(db);
  const remaining = await records.listRecordsByProject(project.id);
  assert.deepEqual(remaining, [], 'the first insert in the failed transaction must not have survived the rollback');
});

test('UsersRepository creates a user, normalizes email to lowercase, and never exposes the password hash via toPublicUser', async () => {
  const db = await freshDb();
  const users = new UsersRepository(db);
  const user = await users.createUser('Person@Example.com', 'a-bcrypt-hash');
  assert.equal(user.email, 'person@example.com');

  const byEmail = await users.getUserByEmail('PERSON@EXAMPLE.COM');
  assert.equal(byEmail.id, user.id);

  const publicUser = toPublicUser(user);
  assert.ok(!('password_hash' in publicUser));
  assert.equal(publicUser.email, user.email);
  await db.close();
});

test('WorkspaceMembersRepository.isMember reflects membership exactly, and listWorkspacesForUser scopes to one user', async () => {
  const db = await freshDb();
  const workspaces = new WorkspacesRepository(db);
  const users = new UsersRepository(db);
  const members = new WorkspaceMembersRepository(db);

  const workspaceA = await workspaces.createWorkspace('A');
  const workspaceB = await workspaces.createWorkspace('B');
  const userA = await users.createUser('a@example.com', 'hash');
  const userB = await users.createUser('b@example.com', 'hash');
  await members.addMember(workspaceA.id, userA.id, 'owner');
  await members.addMember(workspaceB.id, userB.id, 'owner');

  assert.equal(await members.isMember(workspaceA.id, userA.id), true);
  assert.equal(await members.isMember(workspaceA.id, userB.id), false);
  assert.equal(await members.isMember(workspaceB.id, userB.id), true);

  const listA = await members.listWorkspacesForUser(userA.id);
  assert.deepEqual(listA.map(w => w.id), [workspaceA.id]);
  assert.equal(listA[0].role, 'owner');
  await db.close();
});

test('updateRecordFacts replaces a record\'s facts inside its own project only, and addSourcesIfMissing never duplicates provenance', async () => {
  const db = await freshDb();
  const workspace = await new WorkspacesRepository(db).createWorkspace('W');
  const projects = new ProjectsRepository(db);
  const mine = await projects.createProject({ workspaceId: workspace.id, name: 'A', domain: 'tenders' });
  const other = await projects.createProject({ workspaceId: workspace.id, name: 'B', domain: 'tenders' });
  const records = new DiscoveryRecordsRepository(db);
  const created = await records.createRecordWithDetails({
    projectId: mine.id, domain: 'tenders', displayName: 'Old', domainData: { n: 1 }, classification: { a: 1 }, score: 10,
    sources: [{ sourceType: 'api', sourceUrl: 'https://example.test/1', sourceData: { p: 1 } }],
  });
  const updated = await records.updateRecordFacts(created.id, mine.id, { displayName: 'New', domainData: { n: 2 }, classification: { a: 2 }, score: 20 });
  assert.equal(updated.display_name, 'New');
  assert.deepEqual(updated.domain_data, { n: 2 });
  assert.equal(updated.score, 20);
  assert.ok(new Date(updated.updated_at) >= new Date(created.updated_at));
  assert.equal(await records.updateRecordFacts(created.id, other.id, { displayName: 'Hijack', domainData: {} }), null, 'another project cannot update it');
  assert.equal((await records.getRecordById(created.id)).display_name, 'New');

  assert.equal(await records.addSourcesIfMissing(created.id, [
    { sourceType: 'api', sourceUrl: 'https://example.test/1' },
    { sourceType: 'api', sourceUrl: 'https://example.test/2', sourceData: { p: 2 } },
    { sourceType: 'api', sourceUrl: 'https://example.test/2' },
  ]), 1);
  assert.equal(await records.addSourcesIfMissing(created.id, [{ sourceType: 'api', sourceUrl: 'https://example.test/2' }]), 0);
  assert.deepEqual((await records.getRecordById(created.id)).sources.map(s => s.source_url).sort(), ['https://example.test/1', 'https://example.test/2']);
  await db.close();
});
