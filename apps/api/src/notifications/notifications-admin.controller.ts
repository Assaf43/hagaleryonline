import { Controller, Get, Header, NotFoundException, UseGuards } from '@nestjs/common';
import type { AdminSentMessage } from '@hg/models';
import { AdminAuthGuard, RequirePermission, SameOriginGuard } from '../auth/guards.js';
import { NotificationsService } from './notifications.service.js';

/** The dev viewer of the messages the mock "sent" (spec §5.2): 404 unless both providers are `mock`. */
@Controller('admin/dev')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class NotificationsAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('messages')
  @RequirePermission('orders.manage')
  @Header('Cache-Control', 'no-store')
  messages(): Promise<AdminSentMessage[]> {
    if (!this.notifications.devViewerEnabled()) throw new NotFoundException({ statusCode: 404, code: 'not_found' });
    return this.notifications.recent();
  }
}
