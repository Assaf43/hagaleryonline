import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CacheModule } from './cache/cache.module.js';
import { CartModule } from './cart/cart.module.js';
import { CatalogAdminModule } from './catalog-admin/catalog-admin.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { HealthModule } from './health/health.module.js';
import { MediaModule } from './media/media.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ShippingModule } from './shipping/shipping.module.js';

@Module({
  imports: [
    // One .env at the monorepo root serves every app.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    PrismaModule,
    CacheModule,
    MediaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    CatalogAdminModule,
    CartModule,
    ShippingModule,
  ],
})
export class AppModule {}
