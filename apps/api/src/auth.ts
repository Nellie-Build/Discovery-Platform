import type { Request, Response, NextFunction } from 'express';

/**
 * A single, optional shared development API key — not real authentication. When
 * `API_DEV_KEY` is unset, every request passes through unchecked (fine for local development,
 * never for a shared/public deployment). Applied once, centrally, in server.ts, so a real
 * per-user auth scheme can replace this single function later without touching any route.
 */
export function devApiKeyAuth(apiKey: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) { next(); return; }
    if (req.get('x-api-key') !== apiKey) {
      res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid x-api-key header.' });
      return;
    }
    next();
  };
}
