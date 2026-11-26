import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IpThrottle } from '../auth/login-throttle.js';
import { ErrorEventsService } from './error-events.service.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { parseInternalError } from './internal-errors-input.js';

const DEFAULT_LIMIT_PER_MINUTE = 120;

/**
 * The storefront server reports its render errors here (spec 9b.6), with the shared `X-Internal-Token`. Counted
 * under `source = ssr`. Over 120 a minute (all reports share one budget, one storefront) the rest are dropped with
 * the same 204, so a render storm never turns into a request storm on the API. Not for browsers: no origin guard,
 * the token is the check.
 */
@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalErrorsController {
  private readonly throttle: IpThrottle;

  constructor(
    private readonly events: ErrorEventsService,
    config: ConfigService,
  ) {
    const configured = Number(config.get<string>('THROTTLE_INTERNAL_ERRORS_LIMIT'));
    this.throttle = new IpThrottle(
      Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_LIMIT_PER_MINUTE,
      60_000,
    );
  }

  @Post('error-events')
  @HttpCode(204)
  report(@Body() body: unknown): void {
    if (!this.throttle.allow('storefront')) return;
    const input = parseInternalError(body);
    this.events.capture({ ...input, source: 'ssr' });
  }
}
