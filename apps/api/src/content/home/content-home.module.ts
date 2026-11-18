import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { CatalogModule } from '../../catalog/catalog.module.js';
import { PromotionsModule } from '../../promotions/promotions.module.js';
import { HomeAdminController, HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

/**
 * The managed home page (Phase 8 §4.6, decision 98): `GET /api/content/home` and `GET/PUT /api/admin/content/home`.
 * Its own module because it needs the catalog snapshot and the live promotions, while CatalogModule imports
 * ContentModule for the sitemap; ContentModule never imports CatalogModule. The banner delete check reads
 * `home_sections` through Prisma (BannersService), so ContentModule does not import this module either.
 */
@Module({
  imports: [AuthModule, CatalogModule, PromotionsModule],
  controllers: [HomeController, HomeAdminController],
  providers: [HomeService],
})
export class ContentHomeModule {}
