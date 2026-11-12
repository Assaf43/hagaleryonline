import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AdminPromotion, PromotionCategoryOption } from '@hg/models';
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
import { parsePromotionInput } from './promotions-admin-input.js';
import { PromotionsAdminService } from './promotions-admin.service.js';

const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/**
 * "מבצעים וקופונים" (spec §6, ADM-05): list, create, edit, deactivate. No delete endpoint — a promotion is turned
 * off instead (orders keep a link to theirs). Everything needs promotions.manage.
 */
@Controller('admin/promotions')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('promotions.manage')
export class PromotionsAdminController {
  constructor(private readonly promotions: PromotionsAdminService) {}

  @Get()
  list(): Promise<AdminPromotion[]> {
    return this.promotions.list();
  }

  /** Every category in tree order, for the category picker (so the screen does not need catalog permissions). */
  @Get('categories')
  categories(): Promise<PromotionCategoryOption[]> {
    return this.promotions.categories();
  }

  @Get(':id')
  get(@Param('id') promotionId: string): Promise<AdminPromotion> {
    return this.promotions.get(id(promotionId));
  }

  @Post()
  create(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminPromotion> {
    return this.promotions.create(parsePromotionInput(body), meta(admin, client));
  }

  @Put(':id')
  update(
    @Param('id') promotionId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminPromotion> {
    return this.promotions.update(id(promotionId), parsePromotionInput(body), meta(admin, client));
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(
    @Param('id') promotionId: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminPromotion> {
    return this.promotions.deactivate(id(promotionId), meta(admin, client));
  }
}
