import { Controller, Get, Header, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import type { AdminFailedJob } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { OutboxService } from './outbox.service.js';

/** "משימות שנכשלו" (spec §5.1): the FAILED outbox jobs and their retry; permission orders.manage. */
@Controller('admin/jobs')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class OutboxAdminController {
  constructor(private readonly outbox: OutboxService) {}

  @Get('failed')
  @RequirePermission('orders.manage')
  @Header('Cache-Control', 'no-store')
  failed(): Promise<AdminFailedJob[]> {
    return this.outbox.listFailed();
  }

  /** "נסה שוב": the job runs again from its first attempt (audited). */
  @Post(':id/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('orders.manage')
  retry(@Param('id') id: string, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<void> {
    return this.outbox.retry(id, { adminId: admin.user.id, ip: client.ip });
  }
}
