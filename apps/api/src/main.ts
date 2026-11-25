import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { assertProductionEnv } from './config/production-env.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  // Production with a missing or weak secret stops here, before anything is built or a port is opened (spec 9a.3).
  assertProductionEnv();
  // rawBody: the payment webhook verifies its signature over the exact bytes received (spec §5.4).
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }));
  app.enableShutdownHooks();
  await app.listen(process.env.API_PORT ?? 3000);
}
await bootstrap();
