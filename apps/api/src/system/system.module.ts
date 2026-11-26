import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.js';
import { InternalErrorsController } from './internal-errors.controller.js';
import { ErrorEventsService } from './error-events.service.js';

/** JSON logs, the request context and grouped error events (spec 9b.6). Global: any module may log or capture. */
@Global()
@Module({
  controllers: [InternalErrorsController],
  providers: [ErrorEventsService, AppLogger],
  exports: [ErrorEventsService, AppLogger],
})
export class SystemModule {}
