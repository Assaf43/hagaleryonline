import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OutboxAdminController } from './outbox-admin.controller.js';
import { OutboxService } from './outbox.service.js';
import { OutboxWorker } from './outbox.worker.js';

/**
 * The outbox (spec §5.1, decision 83): `OutboxService` (enqueue in the caller's transaction, `runDue`, the admin
 * list and retry), `OutboxWorker` (the poll) and the "משימות שנכשלו" endpoints. Feature modules import it and
 * register the handlers of their job types in `onModuleInit`.
 */
@Module({
  imports: [AuthModule],
  controllers: [OutboxAdminController],
  providers: [OutboxService, OutboxWorker],
  exports: [OutboxService],
})
export class OutboxModule {}
