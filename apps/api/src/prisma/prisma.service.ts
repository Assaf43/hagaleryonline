import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({ connectionString: config.getOrThrow<string>('DATABASE_URL') }),
      // No source code frame, file path or color codes in error messages (NFR-11). Prisma still prints the query
      // argument tree, values included, in a validation error: `scrub` replaces it with `[arguments]`.
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * After every `onModuleDestroy` (and after the HTTP server closed), so the error-events flush on shutdown and any
   * other teardown that writes still has the database, whatever order Nest destroys the modules in.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
