import { ModulesRepository, type TransactionCapable } from '@discovery-platform/db';
import { HttpError } from './http-errors.js';

/**
 * The server-side gate every module-creating/module-using route must pass through — never only
 * hidden in the frontend. Reads the Module Registry (see migrations/004_admin_modules.sql); a
 * module with no row at all (never seeded) is treated the same as explicitly disabled — fail
 * closed, never open, for an unrecognized module id. Then the workspace's own access (see
 * migrations/008_workspace_modules.sql): a module switched off for this workspace is refused
 * there even while it is on globally; a workspace without its own decision follows the global
 * switch. This file knows nothing about vacancies or any other specific module — see
 * domain-registry.ts for the (separate, code-level) question of which module has a real
 * DomainAdapter at all.
 */
export async function assertModuleEnabled(pool: TransactionCapable, moduleId: string, workspaceId: string): Promise<void> {
  const modules = new ModulesRepository(pool);
  const module = await modules.getModule(moduleId);
  if (!module || !module.enabled) {
    const label = module?.name ?? moduleId;
    throw new HttpError(403, 'module_disabled', `The "${label}" module is currently disabled.`);
  }
  const access = (await modules.listWorkspaceAccess(workspaceId)).find(entry => entry.module_id === moduleId);
  if (!access?.enabled) {
    throw new HttpError(403, 'module_not_enabled_for_workspace', `The "${module.name}" module is not enabled for this workspace.`);
  }
}
