import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import type { ErrorGroupDetail, ErrorGroupPage, SystemStatus } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { parseErrorGroupFilter, SystemStatusService } from './system-status.service.js';

/**
 * "תקלות ומצב המערכת" (spec 9b.6), permission `system.view` (the Super Admin has it; others only when granted):
 * `GET status`, `GET errors?state=&page=`, `GET errors/:id` and `POST errors/:id/handled`.
 */
@Controller('admin/system')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('system.view')
@UseInterceptors(NoStoreInterceptor)
export class SystemAdminController {
  constructor(private readonly system: SystemStatusService) {}

  @Get('status')
  status(): Promise<SystemStatus> {
    return this.system.status();
  }

  @Get('errors')
  errors(@Query('state') state: unknown, @Query('page') page: unknown): Promise<ErrorGroupPage> {
    return this.system.listErrors(parseErrorGroupFilter({ state, page }));
  }

  @Get('errors/:id')
  error(@Param('id') id: string): Promise<ErrorGroupDetail> {
    return this.system.errorDetail(id);
  }

  @Post('errors/:id/handled')
  @HttpCode(HttpStatus.NO_CONTENT)
  async handled(
    @Param('id') id: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<void> {
    await this.system.markHandled(id, { actorId: admin.user.id, ip: client.ip });
  }
}
