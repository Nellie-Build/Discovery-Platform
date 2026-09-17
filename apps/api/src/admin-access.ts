import type { Request } from 'express';
import { UsersRepository, type TransactionCapable } from '@discovery-platform/db';
import { HttpError } from './http-errors.js';

/**
 * The one check every admin-only route relies on — see routes/admin.ts. `users.is_admin` (see
 * migrations/004_admin_modules.sql) is the *only* source of truth for "is this user an admin";
 * there is deliberately no hardcoded admin email anywhere in this codebase. The dev-key auth
 * context (see workspace-access.ts) is treated the same way it already is everywhere else — a
 * local-scripts/tests-only bypass, never real Web App auth.
 */
export async function assertAdmin(pool: TransactionCapable, req: Request): Promise<void> {
  if (req.auth?.type === 'dev-key') return;
  if (req.auth?.type !== 'user') throw new HttpError(401, 'unauthorized', 'Log in first.');
  const users = new UsersRepository(pool);
  const user = await users.getUserById(req.auth.userId);
  if (!user?.is_admin) throw new HttpError(403, 'admin_required', 'Admin access required.');
}
