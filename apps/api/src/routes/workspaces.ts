import { Router } from 'express';
import { WorkspacesRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';

export function createWorkspacesRouter(pool: TransactionCapable): Router {
  const router = Router();
  const workspaces = new WorkspacesRepository(pool);

  router.post('/workspaces', asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) throw badRequest('invalid_name', 'name is required.');
    const workspace = await workspaces.createWorkspace(name.trim());
    res.status(201).json(workspace);
  }));

  router.get('/workspaces/:id', asyncHandler(async (req, res) => {
    const workspace = await workspaces.getWorkspaceById(req.params.id);
    if (!workspace) throw notFound('Workspace not found.');
    res.json(workspace);
  }));

  return router;
}
