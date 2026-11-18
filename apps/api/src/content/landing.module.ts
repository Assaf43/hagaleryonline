import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { LandingAdminController, LandingController } from './landing.controller.js';
import { LandingService } from './landing.service.js';
import { PreviewTokens, resolvePreviewSecret } from './preview-token.js';

/**
 * Landing pages (Phase 8 §4.7, MKT-02, decision 97): `GET /api/content/landing/:slug[?preview=]` and
 * `/api/admin/content/landing`. Its own module, like ContentHomeModule, because the grid needs the catalog snapshot and
 * the live promotions while CatalogModule imports ContentModule for the sitemap; the sitemap reads the live landing
 * rows through Prisma in ContentService, so nothing imports this module. The preview tokens are an HMAC under
 * `CONTENT_PREVIEW_SECRET`, required in production (the API refuses to start without it).
 */
@Module({
  imports: [AuthModule, CatalogModule, PromotionsModule],
  controllers: [LandingController, LandingAdminController],
  providers: [
    LandingService,
    {
      provide: PreviewTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PreviewTokens(
          resolvePreviewSecret(config.get<string>('CONTENT_PREVIEW_SECRET'), config.get<string>('NODE_ENV')),
        ),
    },
  ],
})
export class ContentLandingModule {}
