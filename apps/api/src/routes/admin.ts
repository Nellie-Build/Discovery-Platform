import { Router } from 'express';
import { ModulesRepository, ProjectsRepository, WorkspacesRepository, type TransactionCapable, type WorkspaceModuleAccess } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertAdmin } from '../admin-access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The first CMS/Admin backend: manage the Module Registry (enable/disable a module, globally and per
 * workspace) and see every project across every workspace (active and soft-deleted). Every route here
 * requires `users.is_admin` (see admin-access.ts) — checked on every request, never only by hiding the
 * `/admin` link in the Web App's nav.
 */
export function createAdminRouter(pool: TransactionCapable): Router {
  const router = Router();
  const modules = new ModulesRepository(pool);
  const projects = new ProjectsRepository(pool);
  const workspaces = new WorkspacesRepository(pool);

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

  // Per-workspace module access (see migrations/008_workspace_modules.sql). The global switch above stays the
  // master switch; per workspace an admin can switch a module off or on, or clear the decision (`enabled: null`)
  // so the workspace follows the global switch again. Existing projects and records are never touched.
  router.get('/admin/workspace-modules', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    const byWorkspace = new Map<string, { workspace_id: string; workspace_name: string; modules: Omit<WorkspaceModuleAccess, 'workspace_id'>[] }>();
    for (const { workspace_id, workspace_name, ...access } of await modules.listAllWorkspaceAccess()) {
      const entry = byWorkspace.get(workspace_id) ?? { workspace_id, workspace_name, modules: [] };
      entry.modules.push(access);
      byWorkspace.set(workspace_id, entry);
    }
    res.json([...byWorkspace.values()]);
  }));

  router.put('/admin/workspaces/:workspaceId/modules/:moduleId', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean' && enabled !== null) throw badRequest('invalid_enabled', 'enabled must be true, false or null.');
    const { workspaceId, moduleId } = req.params;
    if (!UUID.test(workspaceId) || !(await workspaces.getWorkspaceById(workspaceId))) throw notFound('Workspace not found.');
    if (!(await modules.getModule(moduleId))) throw notFound('Module not found.');
    await modules.setWorkspaceEnabled(workspaceId, moduleId, enabled, req.auth?.type === 'user' ? req.auth.userId : null);
    res.json((await modules.listWorkspaceAccess(workspaceId)).find(access => access.module_id === moduleId));
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
