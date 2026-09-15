import type { Request, Response, NextFunction } from 'express';
import { WorkspaceMembersRepository, type TransactionCapable, type PublicUser } from '@discovery-platform/db';
import { HttpError, notFound } from './http-errors.js';

/**
 * Two ways to be authenticated against this API: a real logged-in user (a session cookie the
 * Web App sets after /auth/login — the normal path from here on), or the shared development
 * API key (`API_DEV_KEY`, unchanged from fase 2.1 — for local scripts/tests only, never real
 * Web App auth; see docs/architecture.md). A dev-key request has no associated user, so it
 * skips every workspace-membership check below entirely — never enable it in a real deployment.
 */
export type AuthContext = { type: 'dev-key' } | { type: 'user'; userId: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function authenticate(apiKey: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const providedKey = req.get('x-api-key');
    if (apiKey && providedKey === apiKey) { req.auth = { type: 'dev-key' }; next(); return; }
    if (req.isAuthenticated?.()) {
      req.auth = { type: 'user', userId: (req.user as PublicUser).id };
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized', message: 'Log in first.' });
  };
}

/**
 * The one check every workspace-scoped route relies on — never trust a workspace/project/run/
 * record id from the client alone. Throws a 404 (not 403) on a real mismatch, so a logged-in
 * user probing another workspace's ids learns nothing about whether that id even exists.
 */
export async function assertWorkspaceAccess(pool: TransactionCapable, req: Request, workspaceId: string): Promise<void> {
  if (req.auth?.type === 'dev-key') return;
  if (req.auth?.type !== 'user') throw new HttpError(401, 'unauthorized', 'Log in first.');
  const members = new WorkspaceMembersRepository(pool);
  const isMember = await members.isMember(workspaceId, req.auth.userId);
  if (!isMember) throw notFound('Workspace not found.');
}
