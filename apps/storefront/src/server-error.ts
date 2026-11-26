import type { NextFunction, Request, Response } from 'express';
import { logJson, reportServerError } from './server-log';
import { stripQuery } from './server-scrub';

/** Shown for any render error: one short line, nothing from the error itself. */
const ERROR_PAGE = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>שגיאה</title></head>
<body><p>אירעה שגיאה. נסו שוב מאוחר יותר.</p></body>
</html>`;

/**
 * The Express error handler after the Angular handler (spec 9b.6): logs the error as JSON, reports it to the API
 * and answers a generic 500 page (the security headers were set by the middleware before it). Once the response has
 * started, Express closes the connection.
 */
export function serverErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl || req.url || '/';
  const error = err instanceof Error ? err : undefined;
  logJson('error', error ? error.message : String(err), {
    path: stripQuery(path),
    ...(error?.stack ? { stack: error.stack } : {}),
  });
  reportServerError(err, path);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).setHeader('Cache-Control', 'no-store').setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ERROR_PAGE);
}
