import { Router } from 'express';
import { ProjectsRepository, DiscoveryRunsRepository, DiscoveryRecordsRepository, withTransaction, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { assertModuleEnabled } from '../module-registry.js';
import { defaultDomainRegistry, resolveDiscoveryRunConfig, type DomainRegistry, type DiscoveryRunConfig } from '../domain-registry.js';

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
    // `runConfig` is never trusted as given — every field is clamped to its own absolute ceiling
    // here, before the domain adapter ever sees it, regardless of what the frontend itself allows
    // a user to type (see resolveDiscoveryRunConfig's own doc comment). `filters` is opaque,
    // module-owned data apps/api never inspects — passed straight through to the adapter.
    const runConfig: DiscoveryRunConfig = resolveDiscoveryRunConfig(
      body.runConfig && typeof body.runConfig === 'object' ? body.runConfig : undefined,
      project.domain,
    );
    const filters: Record<string, unknown> = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? body.filters : {};
    // Two request shapes, both backwards compatible with the original: { sourceUrl } (unchanged)
    // starts a website crawl; { branch, region?, keywords? } starts a branch search. Which one a
    // client sent is inferred from which field is present — no new required field on existing
    // { sourceUrl }-only clients.
    let discoveryInput: { mode: 'website'; sourceUrl: string; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> }
      | { mode: 'source'; sourceId: string; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> }
      | { mode: 'branch'; branch: string; country: string | null; region: string | null; keywords: string | null; runConfig: DiscoveryRunConfig; filters: Record<string, unknown> };
    if (typeof body.sourceUrl === 'string' && body.sourceUrl.trim()) {
      discoveryInput = { mode: 'website', sourceUrl: body.sourceUrl.trim(), runConfig, filters };
    } else if (typeof body.sourceId === 'string' && /^[a-z0-9_-]{1,40}$/.test(body.sourceId.trim())) {
      // A named API/feed source (no crawl): the adapter decides which ids it knows and what its filters mean.
      discoveryInput = { mode: 'source', sourceId: body.sourceId.trim(), runConfig, filters };
    } else if (typeof body.branch === 'string' && body.branch.trim()) {
      discoveryInput = {
        mode: 'branch',
        branch: body.branch.trim(),
        country: typeof body.country === 'string' && body.country.trim() ? body.country.trim() : null,
        region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null,
        keywords: typeof body.keywords === 'string' && body.keywords.trim() ? body.keywords.trim() : null,
        runConfig, filters,
      };
    } else {
      throw badRequest('invalid_source', 'sourceUrl, sourceId or branch is required.');
    }
    const adapter = domainRegistry[project.domain];
    if (!adapter) throw badRequest('unknown_domain', `No domain adapter registered for "${project.domain}".`);
    await assertModuleEnabled(pool, project.domain, project.workspace_id);

    const { runConfig: resolvedConfig, filters: resolvedFilters, ...criteria } = discoveryInput;
    const initialStats = { criteria: { ...criteria, runConfig: resolvedConfig, filters: resolvedFilters } };
    const run = await runs.createRun(project.id, initialStats);
    res.locals.runId = run.id;

    let outcome;
    try {
      const existing = await records.listRecordsByProject(project.id, { domain: project.domain });
      const existingRecords = existing.map(record => ({ id: record.id, domainData: record.domain_data }));
      outcome = await adapter.runDiscovery({ ...discoveryInput, existingRecords });
    } catch (error) {
      const failed = await runs.markFailed(run.id, 'Discovery kon niet worden uitgevoerd.', initialStats);
      res.status(201).json({ ...failed, recordsCreated: 0 });
      return;
    }

    let recordsCreated = 0;
    let recordsUpdated = 0;
    try {
      // Every record from this run is persisted in one transaction: if inserting record N fails
      // (a bad value, a lost connection), record 1..N-1 are rolled back too — a run either
      // contributes all of its records, or none of them, never a partial set.
      await withTransaction(pool, async client => {
        const recordsInTransaction = new DiscoveryRecordsRepository(client);
        for (const record of outcome!.records) {
          const stored = record.existingRecordId ? await recordsInTransaction.getRecordById(record.existingRecordId) : await recordsInTransaction.createRecordWithDetails({
            projectId: project.id, domain: project.domain,
            displayName: record.displayName, domainData: record.domainData,
            classification: record.classification, score: record.score,
            sources: record.sources, contacts: record.contacts,
          });
          if (stored && stored.project_id === project.id) {
            await recordsInTransaction.observeInRun(run.id, { ...stored, domain_data: record.domainData, classification: record.classification });
            if (!record.existingRecordId) recordsCreated++;
          }
        }
        // A later run found newer information about a record that already exists: replace its facts (the domain
        // decided what the new facts are), add the provenance it lacked, and note the observation in this run.
        for (const record of outcome!.updatedRecords ?? []) {
          if (!record.existingRecordId) continue;
          const stored = await recordsInTransaction.getRecordById(record.existingRecordId);
          if (!stored || stored.project_id !== project.id || stored.domain !== project.domain) continue;
          const updated = await recordsInTransaction.updateRecordFacts(stored.id, project.id, {
            displayName: record.displayName, domainData: record.domainData, classification: record.classification, score: record.score,
          });
          if (!updated) continue;
          await recordsInTransaction.addSourcesIfMissing(stored.id, record.sources);
          await recordsInTransaction.observeInRun(run.id, updated);
          recordsUpdated++;
        }
        for (const record of outcome!.observedRecords ?? []) {
          if (!record.existingRecordId) continue;
          const stored = await recordsInTransaction.getRecordById(record.existingRecordId);
          if (stored?.project_id === project.id) await recordsInTransaction.observeInRun(run.id, { ...stored, domain_data: record.domainData, classification: record.classification });
        }
      });
    } catch (error) {
      const failed = await runs.markFailed(run.id, 'Resultaten konden niet worden opgeslagen.', { ...outcome.stats, ...initialStats, recordsCreated: 0, recordsUpdated: 0 });
      res.status(201).json({ ...failed, recordsCreated: 0 });
      return;
    }

    if (outcome.status === 'failed' && outcome.error) {
      const failed = await runs.markFailed(run.id, outcome.error, { ...outcome.stats, ...initialStats, recordsCreated, recordsUpdated });
      res.status(201).json({ ...failed, recordsCreated, recordsUpdated });
      return;
    }
    const succeeded = await runs.finish(run.id, outcome.status ?? 'succeeded', { ...outcome.stats, ...initialStats, recordsCreated, recordsUpdated });
    res.status(201).json({ ...succeeded, recordsCreated, recordsUpdated });
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
