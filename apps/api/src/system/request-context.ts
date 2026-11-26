import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { stripQuery } from './scrub.js';

export interface RequestStore {
  method: string;
  /** The request path without the query string (it may hold an order or preview token). */
  path: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** The current request, for log lines and error events recorded deep inside a request (spec 9b.6). */
export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  current(): RequestStore | undefined {
    return storage.getStore();
  },
};

/**
 * Stores the method and query-free path for the rest of the request. Registered first in `configureApp`; the store
 * reaches the exception filter through the body parsers too (the e2e test posts a JSON body).
 */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  RequestContext.run({ method: req.method, path: stripQuery(req.originalUrl ?? req.url) }, next);
}
