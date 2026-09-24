import type { RequestHandler } from 'express';
import { UsersRepository, toPublicUser, type TransactionCapable } from '@discovery-platform/db';

export function devAuthBypassEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.DEV_AUTH_BYPASS === 'true' && env.NODE_ENV === 'development' && !env.K_SERVICE;
}

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Request-only identity: never mint a session that could survive disabling the bypass. */
export function createDevAuthBypass(pool: TransactionCapable, email: string): RequestHandler {
  const users = new UsersRepository(pool);
  return (req, _res, next) => {
    if (!devAuthBypassEnabled(process.env) || req.isAuthenticated() ||
        !loopback.has(req.socket.remoteAddress ?? '') || !localHosts.has(req.hostname) ||
        req.get('forwarded') || req.get('x-forwarded-for') || req.get('x-forwarded-host')) return next();
    const origin = req.get('origin');
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) return next();
      } catch { return next(); }
    }
    // Login/register/logout keep their normal semantics; /auth/me drives the existing UI.
    if (req.path.startsWith('/auth/') && req.path !== '/auth/me') return next();
    users.getUserByEmail(email).then(user => {
      if (user) req.user = toPublicUser(user);
      next();
    }).catch(next);
  };
}
