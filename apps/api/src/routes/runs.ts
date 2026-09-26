import { Router } from 'express';
import { ProjectsRepository, DiscoveryRunsRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { assertModuleEnabled } from '../module-registry.js';
import { defaultDomainRegistry, type DomainRegistry, type RunContinuation } from '../domain-registry.js';
import { assertNotJobManaged, discoveryInputFrom, executeRun, loadContinuation } from '../run-executor.js';

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

  router.post('/projects/:id/runs', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.locals.projectId = project.id;
    let body = req.body ?? {};
    // A follow-up batch: { continueFromRunId } alone. The earlier run's own request and the cursor it left are read from
    // the database (see run-executor.ts); budgets and module access are checked exactly as for a new run. A run that a
    // background job is processing is continued by that job only.
    let continuation: (RunContinuation & { batch: number }) | undefined;
    if (body.continueFromRunId !== undefined) {
      const loaded = await loadContinuation(pool, project.id, body.continueFromRunId);
      await assertNotJobManaged(pool, loaded.previous);
      body = loaded.request;
      continuation = loaded.continuation;
    }
    const discoveryInput = discoveryInputFrom(body, project.domain);
    const adapter = domainRegistry[project.domain];
    if (!adapter) throw badRequest('unknown_domain', `No domain adapter registered for "${project.domain}".`);
    await assertModuleEnabled(pool, project.domain, project.workspace_id);

    const { run, recordsCreated, recordsUpdated } = await executeRun(pool, adapter, project, discoveryInput, {
      continuation, onRunCreated: async created => { res.locals.runId = created.id; },
    });
    res.status(201).json({ ...run, recordsCreated, recordsUpdated });
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
