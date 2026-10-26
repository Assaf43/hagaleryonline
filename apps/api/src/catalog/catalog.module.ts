import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogService } from './catalog.service.js';
import { PostgresSearchProvider } from './search/postgres-search.provider.js';
import { SearchProvider } from './search/search-provider.js';

@Module({
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService, { provide: SearchProvider, useClass: PostgresSearchProvider }],
  exports: [CatalogService],
})
export class CatalogModule {}
