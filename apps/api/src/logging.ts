import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * One structured JSON line per finished request — request id, route, status, duration, and
 * (when a route sets it) which project/run it touched. Deliberately never reads request/response
 * bodies or headers, so it cannot leak a password, session cookie, API key, or auth header no
 * matter what a future route adds — there is nothing here that could be told to log them.
 * `res.locals.projectId` / `res.locals.runId` are the seam a route uses to attach that context
 * (see routes/runs.ts); most routes never set them, and that's fine — the field is just omitted.
 */
export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const entry: Record<string, unknown> = {
        level: 'info',
        time: new Date().toISOString(),
        requestId,
        method: req.method,
        route: req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };
      if (req.auth?.type === 'user') entry.userId = req.auth.userId;
      if (res.locals.projectId) entry.projectId = res.locals.projectId;
      if (res.locals.runId) entry.runId = res.locals.runId;
      console.log(JSON.stringify(entry));
    });
    next();
  };
}
