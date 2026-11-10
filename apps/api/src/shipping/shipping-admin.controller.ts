import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AdminShippingConfig, AdminShippingZone } from '@hg/models';
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
import { parseRatesInput, parseZoneInput } from './shipping-admin-input.js';
import { ShippingAdminService } from './shipping-admin.service.js';

const meta = (admin: AdminContext, client: RequestMeta) => ({ actorId: admin.user.id, ip: client.ip });

/** Shipping price list and remote zones (spec §4.4, ADM-07). Everything needs shipping.manage. */
@Controller('admin/shipping')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('shipping.manage')
export class ShippingAdminController {
  constructor(private readonly shipping: ShippingAdminService) {}

  @Get()
  get(): Promise<AdminShippingConfig> {
    return this.shipping.config();
  }

  /** The whole price list and the settings, in one transaction. */
  @Put('rates')
  saveRates(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminShippingConfig> {
    return this.shipping.saveRates(parseRatesInput(body), meta(admin, client));
  }

  @Post('zones')
  createZone(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminShippingZone> {
    return this.shipping.createZone(parseZoneInput(body), meta(admin, client));
  }

  @Put('zones/:id')
  updateZone(
    @Param('id') zoneId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminShippingZone> {
    return this.shipping.updateZone(id(zoneId), parseZoneInput(body), meta(admin, client));
  }

  @Delete('zones/:id')
  @HttpCode(204)
  async deleteZone(@Param('id') zoneId: string, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    await this.shipping.deleteZone(id(zoneId), meta(admin, client));
  }
}
