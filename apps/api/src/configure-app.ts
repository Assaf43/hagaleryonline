import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/** Shared by main.ts and the e2e tests, so tests run the same HTTP pipeline as production. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // Behind Caddy in production: take the client IP from the proxy (rate limiting, audit log).
  app.set('trust proxy', 'loopback');
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  return app;
}
