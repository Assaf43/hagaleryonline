import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { AdminHome, HomeView } from '@hg/models';
import type { RequestMeta } from '../../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../../auth/guards.js';
import { expectedUpdatedAt, parseHomeInput } from '../content-admin-input.js';
import { HomeService } from './home.service.js';

/**
 * The home page in one call (Phase 8 §9, NAV-05): public and read-only like the catalog, no Cache-Control header in
 * this phase (the API keeps the rows in `content:home` for 60 seconds).
 */
@Controller('content')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('home')
  get(): Promise<HomeView> {
    return this.home.home();
  }
}

/** "דף הבית" in the admin (Phase 8 §5, ADM-06): content.manage; the whole list in one save with `expectedUpdatedAt`. */
@Controller('admin/content/home')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('content.manage')
export class HomeAdminController {
  constructor(private readonly home: HomeService) {}

  @Get()
  get(): Promise<AdminHome> {
    return this.home.adminHome();
  }

  @Put()
  save(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<AdminHome> {
    const sections = parseHomeInput(body);
    return this.home.saveHome(sections, expectedUpdatedAt(body), { actorId: admin.user.id, ip: client.ip });
  }
}
