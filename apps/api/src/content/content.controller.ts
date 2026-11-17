import { Controller, Get, Param } from '@nestjs/common';
import type { FaqView, InfoPageView, SiteContentView } from '@hg/models';
import { ContentService } from './content.service.js';

/**
 * Public content (Phase 8 §4.1–4.4, NAV-04, SRV-04): read-only, no guards, like the catalog. No Cache-Control header in
 * this phase (Phase 9 decides CDN caching); the API keeps the rows in its own 60-second cache.
 */
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  /** Site details, the announcement shown now and the footer info pages. */
  @Get('site')
  site(): Promise<SiteContentView> {
    return this.content.site();
  }

  /** A published info page; unknown or unpublished → 404 `not_found`. */
  @Get('pages/:slug')
  page(@Param('slug') slug: string): Promise<InfoPageView> {
    return this.content.page(slug);
  }

  @Get('faq')
  faq(): Promise<FaqView> {
    return this.content.faq();
  }
}
