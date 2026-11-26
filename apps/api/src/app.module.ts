import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CacheModule } from './cache/cache.module.js';
import { CartModule } from './cart/cart.module.js';
import { CatalogAdminModule } from './catalog-admin/catalog-admin.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ContentHomeModule } from './content/home/content-home.module.js';
import { ContentModule } from './content/content.module.js';
import { ContentLandingModule } from './content/landing.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { HealthModule } from './health/health.module.js';
import { InvoicingModule } from './invoicing/invoicing.module.js';
import { MarketingModule } from './marketing/marketing.module.js';
import { MediaModule } from './media/media.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ShippingModule } from './shipping/shipping.module.js';
import { SupportModule } from './support/support.module.js';
import { StoreOrdersModule } from './store-orders/store-orders.module.js';
import { SystemModule } from './system/system.module.js';

@Module({
  imports: [
    // One .env at the monorepo root serves every app.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    PrismaModule,
    SystemModule,
    CacheModule,
    MediaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    CatalogAdminModule,
    CartModule,
    ShippingModule,
    OutboxModule,
    NotificationsModule,
    InvoicingModule,
    OrdersModule,
    CustomersModule,
    SupportModule,
    StoreOrdersModule,
    MarketingModule,
    ContentModule,
    ContentHomeModule,
    ContentLandingModule,
  ],
})
export class AppModule {}
