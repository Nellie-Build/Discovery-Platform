import type { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);

/** Wraps an async Express handler so a thrown/rejected error reaches the error-handling
 * middleware in server.ts, instead of crashing the process (Express does not await handlers
 * itself). Also translates Postgres's own "invalid UUID syntax" error into a clean 400 rather
 * than a raw database error leaking to the client. */
export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '22P02') {
        next(badRequest('invalid_id', 'Not a valid id.'));
        return;
      }
      next(error);
    });
  };
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  console.error('Unhandled API error:', error);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
}
