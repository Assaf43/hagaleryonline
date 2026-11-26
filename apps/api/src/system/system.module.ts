import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.js';
import { AuthModule } from '../auth/auth.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { InternalErrorsController } from './internal-errors.controller.js';
import { SystemAdminController } from './system-admin.controller.js';
import { SystemStatusService } from './system-status.service.js';
import { ErrorEventsService } from './error-events.service.js';

/** JSON logs, the request context and grouped error events (spec 9b.6). Global: any module may log or capture. */
@Global()
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [InternalErrorsController, SystemAdminController],
  providers: [ErrorEventsService, AppLogger, SystemStatusService],
  exports: [ErrorEventsService, AppLogger],
})
export class SystemModule {}
