import type { NextFunction, Request, Response } from 'express';
import { logJson, reportServerError } from './server-log';
import { stripQuery } from './server-scrub';

/** Shown for any render error: one short line, nothing from the error itself. */
const ERROR_PAGE = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="robots" content="noindex"><title>שגיאה</title></head>
<body><p>אירעה שגיאה. נסו שוב מאוחר יותר.</p></body>
</html>`;

/** A thrown value that is no `Error` (an `HttpErrorResponse`): its name and message, not `[object Object]`. */
function describeNonError(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    const { name, message } = err as { name?: unknown; message: string };
    return typeof name === 'string' && name ? `${name}: ${message}` : message;
  }
  return String(err);
}

/**
 * Logs a server error as one scrubbed JSON line and reports it to the API's error screen (spec 9b.6). `path` may
 * carry a query string or be a full URL: only its path is kept. Never throws.
 */
export function recordServerError(err: unknown, path: string): void {
  try {
    const error = err instanceof Error ? err : undefined;
    const text = error ? error.message : describeNonError(err);
    logJson('error', text, {
      path: stripQuery(path),
      ...(error?.stack ? { stack: error.stack } : {}),
    });
    reportServerError(error ?? text, path);
  } catch {
    // Recording an error must never raise one.
  }
}

/**
 * The Express error handler after the Angular handler (spec 9b.6): logs the error as JSON, reports it to the API
 * and answers a generic 500 page (the security headers were set by the middleware before it). Once the response has
 * started, Express closes the connection.
 */
export function serverErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  recordServerError(err, req.originalUrl || req.url || '/');
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).setHeader('Cache-Control', 'no-store').setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ERROR_PAGE);
}
