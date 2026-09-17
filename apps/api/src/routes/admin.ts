import { Router } from 'express';
import { ModulesRepository, ProjectsRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertAdmin } from '../admin-access.js';

/**
 * The first CMS/Admin backend: manage the Module Registry (enable/disable a module) and see every
 * project across every workspace (active and soft-deleted). Every route here requires
 * `users.is_admin` (see admin-access.ts) — checked on every request, never only by hiding the
 * `/admin` link in the Web App's nav.
 */
export function createAdminRouter(pool: TransactionCapable): Router {
  const router = Router();
  const modules = new ModulesRepository(pool);
  const projects = new ProjectsRepository(pool);

  router.get('/admin/modules', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    res.json(await modules.listModules());
  }));

  router.patch('/admin/modules/:id', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') throw badRequest('invalid_enabled', 'enabled must be a boolean.');
    const module = await modules.setEnabled(req.params.id, enabled);
    if (!module) throw notFound('Module not found.');
    res.json(module);
  }));

  router.get('/admin/projects', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    res.json(await projects.listAllForAdmin());
  }));

  router.post('/admin/projects/:id/restore', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    const restored = await projects.restoreProject(req.params.id);
    if (!restored) throw notFound('Deleted project not found.');
    res.json(restored);
  }));

  return router;
}
