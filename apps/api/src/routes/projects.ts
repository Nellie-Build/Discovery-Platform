import { Router } from 'express';
import { ProjectsRepository, WorkspacesRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { assertModuleEnabled } from '../module-registry.js';
import { defaultDomainRegistry, type DomainRegistry } from '../domain-registry.js';

export function createProjectsRouter(pool: TransactionCapable, domainRegistry: DomainRegistry = defaultDomainRegistry): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const workspaces = new WorkspacesRepository(pool);

  router.post('/projects', asyncHandler(async (req, res) => {
    const { workspaceId, name, domain, config } = req.body ?? {};
    if (typeof workspaceId !== 'string' || !workspaceId) throw badRequest('invalid_workspace_id', 'workspaceId is required.');
    if (typeof name !== 'string' || !name.trim()) throw badRequest('invalid_name', 'name is required.');
    if (typeof domain !== 'string' || !domainRegistry[domain]) {
      throw badRequest('unknown_domain', `domain must be one of: ${Object.keys(domainRegistry).join(', ')}.`);
    }
    if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
      throw badRequest('invalid_config', 'config must be a JSON object.');
    }
    await assertWorkspaceAccess(pool, req, workspaceId);
    const workspace = await workspaces.getWorkspaceById(workspaceId);
    if (!workspace) throw notFound('Workspace not found.');
    await assertModuleEnabled(pool, domain);
    const project = await projects.createProject({ workspaceId, name: name.trim(), domain, config });
    res.status(201).json(project);
  }));

  // A project id alone is never enough — its owning workspace must also be one the caller
  // belongs to (see workspace-access.ts). This is what stops a guessed/leaked project id from
  // another workspace being usable at all.
  router.get('/projects/:id', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.json(project);
  }));

  // Always scoped to one workspace — see ProjectsRepository.listProjectsByWorkspace: there is no
  // "list every project across every workspace" query anywhere in this API.
  router.get('/projects', asyncHandler(async (req, res) => {
    const { workspaceId } = req.query;
    if (typeof workspaceId !== 'string' || !workspaceId) throw badRequest('invalid_workspace_id', 'workspaceId query parameter is required.');
    await assertWorkspaceAccess(pool, req, workspaceId);
    const workspace = await workspaces.getWorkspaceById(workspaceId);
    if (!workspace) throw notFound('Workspace not found.');
    res.json(await projects.listProjectsByWorkspace(workspaceId));
  }));

  // Soft delete: never a hard DELETE FROM — see ProjectsRepository.softDeleteProject. A project
  // that is already deleted (or never existed) reads the same as "not found" here, since
  // getProjectById excludes deleted rows by default — deleting twice, or deleting an unknown id,
  // both give the same clean 404, never a 500 or a silent no-op.
  router.delete('/projects/:id', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    const deletedBy = req.auth?.type === 'user' ? req.auth.userId : null;
    const deleted = await projects.softDeleteProject(project.id, deletedBy);
    if (!deleted) throw notFound('Project not found.');
    res.status(204).end();
  }));

  return router;
}
