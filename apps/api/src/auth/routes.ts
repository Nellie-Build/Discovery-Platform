import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  UsersRepository, WorkspacesRepository, WorkspaceMembersRepository, toPublicUser,
  withTransaction, type TransactionCapable,
} from '@discovery-platform/db';
import { asyncHandler, badRequest, HttpError } from '../http-errors.js';
import type { PassportInstance } from './passport.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_SALT_ROUNDS = 12;

export function createAuthRouter(pool: TransactionCapable, passport: PassportInstance): Router {
  const router = Router();
  const users = new UsersRepository(pool);

  router.post('/auth/register', asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) throw badRequest('invalid_email', 'A valid email address is required.');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw badRequest('invalid_password', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const existing = await users.getUserByEmail(email);
    if (existing) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // A new account, its first workspace, and the owner membership are created together — if
    // any part fails, none of it exists (see packages/discovery-db/src/connection.ts's
    // withTransaction).
    const { user, workspace } = await withTransaction(pool, async tx => {
      const usersInTx = new UsersRepository(tx);
      const workspacesInTx = new WorkspacesRepository(tx);
      const membersInTx = new WorkspaceMembersRepository(tx);
      const createdUser = await usersInTx.createUser(email, passwordHash);
      const createdWorkspace = await workspacesInTx.createWorkspace('My workspace');
      await membersInTx.addMember(createdWorkspace.id, createdUser.id, 'owner');
      return { user: createdUser, workspace: createdWorkspace };
    });

    req.login(toPublicUser(user), error => {
      if (error) { res.status(500).json({ error: 'internal_error', message: 'Registered, but could not start a session.' }); return; }
      res.status(201).json({ user: toPublicUser(user), workspace });
    });
  }));

  router.post('/auth/login', (req, res, next) => {
    passport.authenticate('local', (error: unknown, user: Express.User | false, info: { message?: string } | undefined) => {
      if (error) { next(error); return; }
      if (!user) { res.status(401).json({ error: 'invalid_credentials', message: info?.message ?? 'Invalid email or password.' }); return; }
      req.login(user, loginError => {
        if (loginError) { next(loginError); return; }
        res.json(user);
      });
    })(req, res, next);
  });

  router.post('/auth/logout', (req, res, next) => {
    req.logout(error => {
      if (error) { next(error); return; }
      req.session.destroy(destroyError => {
        if (destroyError) { next(destroyError); return; }
        res.clearCookie('discovery_platform_sid');
        res.status(204).end();
      });
    });
  });

  router.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated()) { res.status(401).json({ error: 'unauthorized', message: 'Not logged in.' }); return; }
    res.json(req.user);
  });

  return router;
}
