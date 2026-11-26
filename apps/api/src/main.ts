import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { assertProductionEnv } from './config/production-env.js';
import { configureApp } from './configure-app.js';
import { AppLogger } from './system/app-logger.js';

async function bootstrap() {
  // Production with a missing or weak secret stops here, before anything is built or a port is opened (spec 9a.3).
  assertProductionEnv();
  // rawBody: the payment webhook verifies its signature over the exact bytes received (spec §5.4).
  // bufferLogs: start-up lines wait for AppLogger (JSON, scrubbed, errors grouped — spec 9b.6).
  const app = configureApp(
    await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true }),
  );
  app.useLogger(app.get(AppLogger));
  app.enableShutdownHooks();
  await app.listen(process.env.API_PORT ?? 3000);
}
await bootstrap();
