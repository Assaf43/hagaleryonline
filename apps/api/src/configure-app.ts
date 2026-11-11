import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { LocalDiskStorage } from './media/local-disk-storage.js';
import { StorageProvider } from './media/storage.js';
import { trustProxySetting } from './trust-proxy.js';

/** Shared by main.ts and the e2e tests, so tests run the same HTTP pipeline as production. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  // Behind Caddy in production: take the client IP from the proxy (rate limiting, audit log). TRUST_PROXY names it.
  app.set('trust proxy', trustProxySetting(app.get(ConfigService).get<string>('TRUST_PROXY')));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  // Local-disk photos are served by the API here; Caddy or a CDN takes this over in production.
  const storage = app.get(StorageProvider);
  if (storage instanceof LocalDiskStorage)
    app.useStaticAssets(storage.publicDir, {
      prefix: storage.urlPrefix,
      immutable: true,
      maxAge: '365d',
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    });
  return app;
}
