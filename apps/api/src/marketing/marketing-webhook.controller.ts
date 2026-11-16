import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  MARKETING_PROVIDER,
  MarketingWebhookPayloadError,
  MarketingWebhookSignatureError,
  type MarketingProvider,
  type MarketingWebhookEvent,
} from './marketing-provider.js';
import { MarketingService } from './marketing.service.js';

/**
 * `POST /api/marketing/webhook` (spec §5.4, CLB-11): the e-mail tool reports unsubscribes. No origin guard — the tool
 * calls it — and no throttle, like the payments webhook: the signature over the exact raw body is the check (the app
 * is created with `rawBody: true`). Bad signature → 401, a signed body that makes no sense → 400, otherwise 204; each
 * event goes to `MarketingService.providerUnsubscribed`, which records a repeated event id only once.
 */
@Controller('marketing')
export class MarketingWebhookController {
  constructor(
    @Inject(MARKETING_PROVIDER) private readonly provider: MarketingProvider,
    private readonly marketing: MarketingService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(@Req() req: RawBodyRequest<Request>): Promise<void> {
    // No raw bytes (a body type the parsers skip): nothing can verify, so it is refused (401).
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    let events: MarketingWebhookEvent[];
    try {
      events = this.provider.verifyWebhook(raw, req.headers);
    } catch (e) {
      if (e instanceof MarketingWebhookSignatureError)
        throw new UnauthorizedException({ statusCode: 401, code: 'invalid_signature' });
      if (e instanceof MarketingWebhookPayloadError)
        throw new BadRequestException({ statusCode: 400, code: 'invalid_payload' });
      throw e;
    }
    for (const event of events) await this.marketing.providerUnsubscribed(event.email, event.id);
  }
}
