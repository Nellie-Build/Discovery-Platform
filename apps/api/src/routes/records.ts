import { Router } from 'express';
import { ProjectsRepository, DiscoveryRecordsRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, notFound } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export function createRecordsRouter(pool: TransactionCapable): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const records = new DiscoveryRecordsRepository(pool);

  // Always scoped to one project — the same isolation boundary as GET /projects.
  router.get('/projects/:id/records', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    res.json(await records.listRecordsByProject(project.id, { domain }));
  }));

  // A record id alone is never enough — resolve its project, then that project's workspace,
  // before ever returning the record. This is what stops a record id from another workspace
  // being usable to read that workspace's data.
  router.get('/records/:id', asyncHandler(async (req, res) => {
    const record = await records.getRecordById(req.params.id);
    if (!record) throw notFound('Record not found.');
    const project = await projects.getProjectById(record.project_id);
    if (!project) throw notFound('Record not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.json(record);
  }));

  return router;
}
