import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SandboxCompleteResponse, SandboxPaymentView } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { PaymentsService } from './payments.service.js';

/**
 * Payments API (spec §5.3, §5.4). The webhook has no origin guard: the provider calls it, and its signature over
 * the raw body is the check (main.ts creates the app with `rawBody: true`). The sandbox endpoints are called by the
 * storefront's sandbox page and go through StorefrontOriginGuard.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    // No raw bytes (a body type the parsers skip, or rawBody not enabled): nothing can verify, so it is refused (401).
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    await this.payments.handleWebhook(req.headers, raw);
    return { received: true };
  }

  @Get('sandbox/:transactionId')
  @UseGuards(StorefrontOriginGuard)
  @Header('Cache-Control', 'no-store')
  sandboxView(@Param('transactionId') transactionId: string): Promise<SandboxPaymentView> {
    return this.payments.sandboxView(transactionId);
  }

  @Post('sandbox/:transactionId/complete')
  @UseGuards(StorefrontOriginGuard)
  @HttpCode(HttpStatus.OK)
  complete(@Param('transactionId') transactionId: string, @Body() body: unknown): Promise<SandboxCompleteResponse> {
    return this.payments.completeSandbox(transactionId, body);
  }
}
