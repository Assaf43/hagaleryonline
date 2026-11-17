import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { PostgresSearchProvider } from './search/postgres-search.provider.js';
import { SearchProvider } from './search/search-provider.js';

@Module({
  // The sitemap also lists info pages (Phase 8 §9).
  imports: [ContentModule],
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService, { provide: SearchProvider, useClass: PostgresSearchProvider }],
  exports: [CatalogService],
})
export class CatalogModule {}
