import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import { ProductsAdminController, StructureAdminController } from './catalog-admin.controller.js';
import { ProductsAdminService } from './products-admin.service.js';
import { StructureAdminService } from './structure-admin.service.js';

/** Catalog management in the admin (Phase 2b). */
@Module({
  imports: [AuthModule],
  controllers: [ProductsAdminController, StructureAdminController],
  providers: [ProductsAdminService, StructureAdminService, SearchIndexer],
})
export class CatalogAdminModule {}
