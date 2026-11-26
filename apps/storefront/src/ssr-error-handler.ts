import { ErrorHandler, Injectable, REQUEST, inject } from '@angular/core';
import { recordServerError } from './server-error';

/**
 * The server render's `ErrorHandler` (spec 9b.6, NFR-11): an error in a component, an effect or an HTTP call during
 * a render is logged as scrubbed JSON and reported to the API with the request path, instead of Angular's raw
 * `console.error`. Never rethrows: the render goes on as it would with the default handler. Server config only.
 */
@Injectable()
export class ServerErrorHandler implements ErrorHandler {
  private readonly request = inject(REQUEST, { optional: true });

  handleError(error: unknown): void {
    let path = '/';
    try {
      path = this.request?.url || '/';
    } catch {
      // No request URL: the root path.
    }
    recordServerError(error, path);
  }
}
