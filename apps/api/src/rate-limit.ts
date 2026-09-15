import rateLimit from 'express-rate-limit';

/**
 * Basic, server-side protection for the online test environment against credential brute-force
 * (login/register) and crawler misuse (starting Discovery runs) — deliberately simple: one
 * in-memory counter per client IP (`app.set('trust proxy', 1)` in server.ts makes `req.ip`
 * reflect the real client through Cloud Run's proxy), no external store. Only mounted when
 * `CreateAppOptions.rateLimiting` is true (see server.ts) — off by default so the existing test
 * suite, which registers/logs in far more than these limits within a single test file, is
 * unaffected; main() turns it on for the real deployed server.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Please wait and try again.' },
});

export const runsRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method !== 'POST',
  message: { error: 'rate_limited', message: 'Too many Discovery runs started. Please wait and try again.' },
});
