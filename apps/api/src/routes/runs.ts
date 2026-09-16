import { Router } from 'express';
import { ProjectsRepository, DiscoveryRunsRepository, DiscoveryRecordsRepository, withTransaction, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { defaultDomainRegistry, type DomainRegistry } from '../domain-registry.js';

/**
 * The one route that actually exercises the whole chain this phase exists to prove:
 * HTTP request -> discovery-core's crawler (via the domain adapter) -> the domain module's own
 * extraction/scoring/dedupe -> PostgreSQL -> API response. This file never parses a domain
 * field itself — it only asks the domain registry for the project's own adapter to do the
 * discovery work, then persists whatever it returns.
 */
export function createRunsRouter(pool: TransactionCapable, domainRegistry: DomainRegistry = defaultDomainRegistry): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const runs = new DiscoveryRunsRepository(pool);
  const records = new DiscoveryRecordsRepository(pool);

  router.post('/projects/:id/runs', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.locals.projectId = project.id;
    const body = req.body ?? {};
    // Two request shapes, both backwards compatible with the original: { sourceUrl } (unchanged)
    // starts a website crawl; { branch, region?, keywords? } starts a branch search. Which one a
    // client sent is inferred from which field is present — no new required field on existing
    // { sourceUrl }-only clients.
    let discoveryInput: { mode: 'website'; sourceUrl: string } | { mode: 'branch'; branch: string; region: string | null; keywords: string | null };
    if (typeof body.sourceUrl === 'string' && body.sourceUrl.trim()) {
      discoveryInput = { mode: 'website', sourceUrl: body.sourceUrl.trim() };
    } else if (typeof body.branch === 'string' && body.branch.trim()) {
      discoveryInput = {
        mode: 'branch',
        branch: body.branch.trim(),
        region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null,
        keywords: typeof body.keywords === 'string' && body.keywords.trim() ? body.keywords.trim() : null,
      };
    } else {
      throw badRequest('invalid_source', 'sourceUrl or branch is required.');
    }
    const adapter = domainRegistry[project.domain];
    if (!adapter) throw badRequest('unknown_domain', `No domain adapter registered for "${project.domain}".`);

    const run = await runs.createRun(project.id);
    res.locals.runId = run.id;

    let outcome;
    try {
      const existing = await records.listRecordsByProject(project.id, { domain: project.domain });
      const existingRecords = existing.map(record => ({ id: record.id, domainData: record.domain_data }));
      outcome = await adapter.runDiscovery({ ...discoveryInput, existingRecords });
    } catch (error) {
      const failed = await runs.markFailed(run.id, error instanceof Error ? error.message : String(error));
      res.status(201).json({ ...failed, recordsCreated: 0 });
      return;
    }

    try {
      // Every record from this run is persisted in one transaction: if inserting record N fails
      // (a bad value, a lost connection), record 1..N-1 are rolled back too — a run either
      // contributes all of its records, or none of them, never a partial set.
      await withTransaction(pool, async client => {
        const recordsInTransaction = new DiscoveryRecordsRepository(client);
        for (const record of outcome!.records) {
          await recordsInTransaction.createRecordWithDetails({
            projectId: project.id, domain: project.domain,
            displayName: record.displayName, domainData: record.domainData,
            classification: record.classification, score: record.score,
            sources: record.sources, contacts: record.contacts,
          });
        }
      });
    } catch (error) {
      const failed = await runs.markFailed(run.id, error instanceof Error ? error.message : String(error), outcome.stats);
      res.status(201).json({ ...failed, recordsCreated: 0 });
      return;
    }

    const succeeded = await runs.markSucceeded(run.id, outcome.stats);
    res.status(201).json({ ...succeeded, recordsCreated: outcome.records.length });
  }));

  router.get('/projects/:id/runs', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.json(await runs.listRunsByProject(project.id));
  }));

  // A run id alone is never enough — resolve its project, then that project's workspace, before
  // ever returning the run (same reasoning as GET /projects/:id).
  router.get('/runs/:id', asyncHandler(async (req, res) => {
    const run = await runs.getRunById(req.params.id);
    if (!run) throw notFound('Run not found.');
    res.locals.runId = run.id;
    const project = await projects.getProjectById(run.project_id);
    if (!project) throw notFound('Run not found.');
    res.locals.projectId = project.id;
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.json(run);
  }));

  return router;
}
