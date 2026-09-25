import { Router } from 'express';
import { ModulesRepository, ProjectsRepository, WorkspacesRepository, withTransaction, type TransactionCapable, type WorkspaceModuleAccess } from '@discovery-platform/db';
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

  // Per-workspace module access (migrations/008_workspace_modules.sql, 009_module_packages.sql). The global switch
  // above always wins; per workspace an admin picks a package, and can switch single modules on or off against it
  // (`enabled: null` = follow the package again). Existing projects, runs and records are never touched.
  router.get('/admin/module-packages', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    res.json(await modules.listPackages());
  }));

  router.get('/admin/workspace-modules', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    type Entry = { workspace_id: string; workspace_name: string; package_id: string; package_name: string; customized: boolean; modules: Omit<WorkspaceModuleAccess, 'workspace_id' | 'package_id'>[] };
    const byWorkspace = new Map<string, Entry>();
    for (const { workspace_id, workspace_name, package_id, package_name, ...access } of await modules.listAllWorkspaceAccess()) {
      const entry = byWorkspace.get(workspace_id) ?? { workspace_id, workspace_name, package_id, package_name, customized: false, modules: [] };
      entry.modules.push(access);
      entry.customized ||= access.deviates;
      byWorkspace.set(workspace_id, entry);
    }
    res.json([...byWorkspace.values()]);
  }));

  router.put('/admin/workspaces/:workspaceId/package', asyncHandler(async (req, res) => {
    await assertAdmin(pool, req);
    const { packageId } = req.body ?? {};
    if (typeof packageId !== 'string' || !packageId) throw badRequest('invalid_package', 'packageId is required.');
    const { workspaceId } = req.params;
    if (!UUID.test(workspaceId) || !(await workspaces.getWorkspaceById(workspaceId))) throw notFound('Workspace not found.');
    const updatedBy = req.auth?.type === 'user' ? req.auth.userId : null;
    const found = await withTransaction(pool, tx => new ModulesRepository(tx).setWorkspacePackage(workspaceId, packageId, updatedBy));
    if (!found) throw notFound('Package not found.');
    res.json(await modules.listWorkspaceAccess(workspaceId));
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
