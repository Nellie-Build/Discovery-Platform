import { Router } from 'express';
import { ProjectsRepository, DiscoveryRecordsRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, notFound } from '../http-errors.js';

export function createRecordsRouter(pool: TransactionCapable): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const records = new DiscoveryRecordsRepository(pool);

  // Always scoped to one project — the same isolation boundary as GET /projects.
  router.get('/projects/:id/records', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    res.json(await records.listRecordsByProject(project.id, { domain }));
  }));

  router.get('/records/:id', asyncHandler(async (req, res) => {
    const record = await records.getRecordById(req.params.id);
    if (!record) throw notFound('Record not found.');
    res.json(record);
  }));

  return router;
}
