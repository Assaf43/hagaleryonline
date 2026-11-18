import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AdminLandingPage, AdminLandingPreview, LandingResponse } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import { id } from '../auth/body.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { expectedUpdatedAt, parseLandingInput } from './content-admin-input.js';
import { LandingService } from './landing.service.js';

const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/**
 * A landing page for the site (Phase 8 §4.7, MKT-02): 200 `live` / `preview`, 404 `not_found` (unknown, draft or not
 * started — nothing of the page in the body), 410 `{ state: 'ended', titleHe, endedLinkUrl }`. No Cache-Control on the
 * public answer in this phase (like the catalog); any request carrying `?preview=` answers `no-store`, whatever the
 * outcome, so a shared cache never keeps a staff view.
 */
@Controller('content/landing')
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  @Get(':slug')
  get(
    @Param('slug') slug: string,
    @Query('preview') preview: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LandingResponse> {
    if (preview !== undefined) res.setHeader('Cache-Control', 'no-store');
    return this.landing.landing(slug, typeof preview === 'string' ? preview : undefined);
  }
}

/** "עמודי נחיתה" in the admin (Phase 8 §4.7, §5, MKT-02, ADM-06): content.manage; updates send `expectedUpdatedAt`. */
@Controller('admin/content/landing')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('content.manage')
export class LandingAdminController {
  constructor(private readonly landing: LandingService) {}

  @Get()
  list(): Promise<AdminLandingPage[]> {
    return this.landing.list();
  }

  @Get(':id')
  get(@Param('id') pageId: string): Promise<AdminLandingPage> {
    return this.landing.get(id(pageId));
  }

  @Post()
  create(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminLandingPage> {
    return this.landing.create(parseLandingInput(body), meta(admin, client));
  }

  @Put(':id')
  update(
    @Param('id') pageId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminLandingPage> {
    const input = parseLandingInput(body);
    return this.landing.update(id(pageId), input, expectedUpdatedAt(body), meta(admin, client));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') pageId: string, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<void> {
    return this.landing.remove(id(pageId), meta(admin, client));
  }

  /** A signed storefront address valid 30 minutes; answered `no-store` (it carries the token). */
  @Post(':id/preview')
  @HttpCode(200)
  preview(
    @Param('id') pageId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminLandingPreview> {
    res.setHeader('Cache-Control', 'no-store');
    return this.landing.preview(id(pageId), meta(admin, client));
  }
}
