import { Router } from 'express';
import { ModulesRepository, WorkspacesRepository, WorkspaceMembersRepository, withTransaction, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound, HttpError } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export function createWorkspacesRouter(pool: TransactionCapable): Router {
  const router = Router();
  const workspaces = new WorkspacesRepository(pool);
  const members = new WorkspaceMembersRepository(pool);
  const modules = new ModulesRepository(pool);

  // The Web App's normal signup flow creates a workspace automatically (see auth/routes.ts's
  // /auth/register) — this endpoint is for a logged-in user creating an *additional* workspace,
  // or for a dev-key script creating a bare one with no members at all (unchanged since fase 2.1).
  router.post('/workspaces', asyncHandler(async (req, res) => {
    const { name } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) throw badRequest('invalid_name', 'name is required.');

    if (req.auth?.type === 'user') {
      const userId = req.auth.userId;
      const workspace = await withTransaction(pool, async tx => {
        const workspacesInTx = new WorkspacesRepository(tx);
        const membersInTx = new WorkspaceMembersRepository(tx);
        const created = await workspacesInTx.createWorkspace(name.trim());
        await membersInTx.addMember(created.id, userId, 'owner');
        return created;
      });
      res.status(201).json(workspace);
      return;
    }

    const workspace = await workspaces.createWorkspace(name.trim());
    res.status(201).json(workspace);
  }));

  // Every workspace the current user belongs to — never every workspace that exists. Requires
  // a real logged-in user; "mine" has no meaning for a dev-key script with no associated user.
  router.get('/workspaces', asyncHandler(async (req, res) => {
    if (req.auth?.type !== 'user') throw new HttpError(403, 'requires_user_session', 'This endpoint requires a logged-in user, not a dev API key.');
    res.json(await members.listWorkspacesForUser(req.auth.userId));
  }));

  router.get('/workspaces/:id', asyncHandler(async (req, res) => {
    await assertWorkspaceAccess(pool, req, req.params.id);
    const workspace = await workspaces.getWorkspaceById(req.params.id);
    if (!workspace) throw notFound('Workspace not found.');
    res.json(workspace);
  }));

  // Which modules this workspace may use for new projects and runs — for the Web App's forms only;
  // the decision itself is enforced by module-registry.ts on every create/run request.
  router.get('/workspaces/:id/modules', asyncHandler(async (req, res) => {
    await assertWorkspaceAccess(pool, req, req.params.id);
    const access = await modules.listWorkspaceAccess(req.params.id);
    if (access.length === 0) throw notFound('Workspace not found.');
    res.json(access.map(({ module_id, module_name, enabled }) => ({ module_id, module_name, enabled })));
  }));

  return router;
}
