import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AdminBanner } from '@hg/models';
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
import { expectedUpdatedAt, parseBannerInput } from './content-admin-input.js';
import { BannersService } from './banners.service.js';

const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/** "באנרים" in the admin (Phase 8 §4.5, §5, NAV-05, ADM-06): content.manage; updates send `expectedUpdatedAt`. */
@Controller('admin/content/banners')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('content.manage')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  list(): Promise<AdminBanner[]> {
    return this.banners.list();
  }

  @Get(':id')
  get(@Param('id') bannerId: string): Promise<AdminBanner> {
    return this.banners.get(id(bannerId));
  }

  @Post()
  create(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<AdminBanner> {
    return this.banners.create(parseBannerInput(body), meta(admin, client));
  }

  @Put(':id')
  update(
    @Param('id') bannerId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminBanner> {
    const input = parseBannerInput(body);
    return this.banners.update(id(bannerId), input, expectedUpdatedAt(body), meta(admin, client));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id') bannerId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<void> {
    return this.banners.remove(id(bannerId), meta(admin, client));
  }
}
