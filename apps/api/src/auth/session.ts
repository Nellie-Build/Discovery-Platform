/**
 * Cookie-based session storage backed by PostgreSQL (connect-pg-simple, using the `session`
 * table from packages/discovery-db/migrations/002_auth.sql) — sessions survive an API restart
 * and are never held only in server memory. The cookie itself is httpOnly (never readable by
 * JavaScript, so never stored in localStorage by the Web App either) and `secure` in
 * production (HTTPS-only).
 */
import session from 'express-session';
import createPgSessionStore from 'connect-pg-simple';
import type { TransactionCapable } from '@discovery-platform/db';

export interface SessionOptions {
  secret: string;
  secure: boolean;
}

export function createSessionMiddleware(pool: TransactionCapable, options: SessionOptions) {
  const PgSession = createPgSessionStore(session);
  return session({
    // `pool` only needs the small subset of `pg.Pool` connect-pg-simple actually calls
    // (`.query()`); a PGlite instance satisfies that in tests. Periodic pruning is disabled so
    // it never needs `.connect()`/a dedicated client either — one less thing test doubles need
    // to support.
    store: new PgSession({ pool: pool as unknown as import('pg').Pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: false }),
    secret: options.secret,
    resave: false,
    saveUninitialized: false,
    name: 'discovery_platform_sid',
    cookie: {
      httpOnly: true,
      secure: options.secure,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}
