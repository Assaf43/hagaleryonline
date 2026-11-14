import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomerSessionModule } from '../customers/customer-session.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { SupportAttachments } from './attachments.js';
import { StoreSettingsAdminController, SupportAdminController } from './support-admin.controller.js';
import { SupportAdminService } from './support-admin.service.js';
import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { TicketMessagesJob } from './ticket-messages.job.js';

/**
 * Support tickets (Phase 5d, spec §7): the storefront requests (returns, exchanges, damaged products, contact), the
 * ticket e-mails, the admin inbox and the return window setting (§7.2), and `SupportService.open()` for the orders
 * module (the delivery link's change request). It does not import the orders module, which imports this one.
 */
@Module({
  imports: [AuthModule, CustomerSessionModule, WriteThrottleModule, OutboxModule, NotificationsModule],
  controllers: [SupportController, SupportAdminController, StoreSettingsAdminController],
  providers: [SupportService, SupportAdminService, SupportAttachments, TicketMessagesJob],
  exports: [SupportService],
})
export class SupportModule {}
