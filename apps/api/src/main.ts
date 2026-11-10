import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  // rawBody: the payment webhook verifies its signature over the exact bytes received (spec §5.4).
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }));
  app.enableShutdownHooks();
  await app.listen(process.env.API_PORT ?? 3000);
}
await bootstrap();
