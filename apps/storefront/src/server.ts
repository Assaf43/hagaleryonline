import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { previewNoStore } from './preview-no-store';
import { registerSeoRoutes } from './seo-routes';
import { securityHeaders } from './security-headers';
import { readServerEnv } from './server-env';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();
const env = readServerEnv();

/** CSP with a per-request nonce, Permissions-Policy, nosniff, X-Frame-Options, Referrer-Policy (NFR-07). */
app.use(securityHeaders(env.csp));

/**
 * sitemap.xml and robots.txt (NFR-06), before the static files and the Angular handler.
 * Same defaults as the server render (app.config.server.ts).
 */
registerSeoRoutes(app, env);

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use(previewNoStore);
app.use((req, res, next) => {
  angularApp
    // The nonce reaches the render as CSP_NONCE (app.config.server.ts), so Angular puts it on its inline tags.
    .handle(req, { cspNonce: res.locals['cspNonce'] })
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
