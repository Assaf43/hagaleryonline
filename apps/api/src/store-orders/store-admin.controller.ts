import { Body, Controller, Get, Header, Put, UseGuards } from '@nestjs/common';
import type { StoreInfo } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  SameOriginGuard,
  SuperAdminOnly,
  type AdminContext,
} from '../auth/guards.js';
import { parseStoreInput, StoreService } from './store.service.js';

/** The store's details (spec §4.4): `GET` and `PUT /api/admin/store`, Super Admin only, audited as `store.update`. */
@Controller('admin/store')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@SuperAdminOnly()
export class StoreAdminController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<StoreInfo> {
    return this.store.get();
  }

  @Put()
  save(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<StoreInfo> {
    return this.store.update(parseStoreInput(body), { actorId: admin.user.id, ip: client.ip });
  }
}
