import { ModulesRepository, type TransactionCapable } from '@discovery-platform/db';
import { HttpError } from './http-errors.js';

/**
 * The server-side gate every module-creating/module-using route must pass through — never only
 * hidden in the frontend. Reads the Module Registry (see migrations/004_admin_modules.sql); a
 * module with no row at all (never seeded) is treated the same as explicitly disabled — fail
 * closed, never open, for an unrecognized module id. This file knows nothing about vacancies or
 * any other specific module — see domain-registry.ts for the (separate, code-level) question of
 * which module has a real DomainAdapter at all.
 */
export async function assertModuleEnabled(pool: TransactionCapable, moduleId: string): Promise<void> {
  const modules = new ModulesRepository(pool);
  const module = await modules.getModule(moduleId);
  if (!module || !module.enabled) {
    const label = module?.name ?? moduleId;
    throw new HttpError(403, 'module_disabled', `The "${label}" module is currently disabled.`);
  }
}
