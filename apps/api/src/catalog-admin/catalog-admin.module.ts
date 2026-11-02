import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import { ExcelController, ProductsAdminController, StructureAdminController } from './catalog-admin.controller.js';
import { ExcelService } from './excel/excel.service.js';
import { ProductsAdminService } from './products-admin.service.js';
import { StructureAdminService } from './structure-admin.service.js';

/** Catalog management in the admin (Phase 2b) and Excel import/export (Phase 2c). */
@Module({
  imports: [AuthModule],
  controllers: [ProductsAdminController, StructureAdminController, ExcelController],
  providers: [ProductsAdminService, StructureAdminService, ExcelService, SearchIndexer],
})
export class CatalogAdminModule {}
