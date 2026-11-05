import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import {
  ExcelController,
  ImagesAdminController,
  ProductsAdminController,
  StructureAdminController,
} from './catalog-admin.controller.js';
import { ExcelService } from './excel/excel.service.js';
import { ImagesAdminService } from './images-admin.service.js';
import { ProductsAdminService } from './products-admin.service.js';
import { StructureAdminService } from './structure-admin.service.js';

/** Catalog management in the admin (Phase 2b), Excel import/export (Phase 2c) and photos (Phase 2d). */
@Module({
  imports: [AuthModule],
  controllers: [ProductsAdminController, ImagesAdminController, StructureAdminController, ExcelController],
  providers: [ProductsAdminService, ImagesAdminService, StructureAdminService, ExcelService, SearchIndexer],
})
export class CatalogAdminModule {}
