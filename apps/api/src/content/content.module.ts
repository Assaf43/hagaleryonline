import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ContentAdminController } from './content-admin.controller.js';
import { ContentAdminService } from './content-admin.service.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

/**
 * Content management (Phase 8, spec specs/2026-11-17-phase-8-cms-design.md): public reads under /api/content and the
 * admin "תוכן" screens under /api/admin/content. Exports ContentService for the sitemap (CatalogModule). It does not
 * import the catalog, so CatalogModule can import it without a cycle.
 */
@Module({
  imports: [AuthModule],
  controllers: [ContentController, ContentAdminController],
  providers: [ContentService, ContentAdminService],
  exports: [ContentService],
})
export class ContentModule {}
