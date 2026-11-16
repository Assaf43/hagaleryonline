import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { normalizeEmail } from '../customers/contact-normalize.js';
import { maskEmail } from '../notifications/masking.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isHoneypot } from '../support/support-input.js';
import { MarketingService } from './marketing.service.js';

type Body_ = Record<string, unknown>;
const asBody = (raw: unknown): Body_ => (typeof raw === 'object' && raw !== null ? (raw as Body_) : {});
const badField = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });
const linkInvalid = () => new NotFoundException({ statusCode: 404, code: 'link_invalid' });

/**
 * The newsletter (spec §4.4, §6, MKT-01, CLB-02, decision 95): `POST /api/newsletter` asks for a confirmation link
 * and answers 202 `{}` whether or not the address is known, subscribed or over its daily limit (nothing to probe);
 * `confirm/preview`, `confirm` and `unsubscribe` are the calls of the link pages. The link page only previews on load
 * (read-only: the masked address of a live link) and confirms on the customer's click, so a mail scanner that opens
 * the link confirms nothing. Storefront origin only and never cached; sign-up, preview and confirm count in the
 * `newsletter` bucket per IP (`THROTTLE_NEWSLETTER_LIMIT`), unsubscribe in its own `newsletter_unsubscribe`
 * (`THROTTLE_NEWSLETTER_UNSUBSCRIBE_LIMIT`). A filled honeypot `website` answers 202 `{}` and saves nothing.
 */
@Controller('newsletter')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard)
export class NewsletterController {
  constructor(
    private readonly marketing: MarketingService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter')
  async subscribe(@Body() body: unknown, @Req() req: Request): Promise<Record<string, never>> {
    if (isHoneypot(body)) return {};
    const b = asBody(body);
    const email = normalizeEmail(b.email);
    if (!email) throw badField('email');
    if (b.consent !== true) throw badField('consent');
    await this.prisma.$transaction((tx) =>
      this.marketing.requestConfirmation(tx, {
        email,
        source: 'newsletter',
        channel: 'email',
        actor: { ip: req.ip },
      }),
    );
    return {};
  }

  /** Read-only: changes nothing and never uses the token. 200 `{ email }` (masked) or 404 `link_invalid`. */
  @Post('confirm/preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter')
  async preview(@Body() body: unknown): Promise<{ email: string }> {
    const token = asBody(body).token;
    const found = typeof token === 'string' ? await this.marketing.previewConfirmation(token) : null;
    if (!found) throw linkInvalid();
    return { email: maskEmail(found.email) };
  }

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter')
  async confirm(@Body() body: unknown, @Req() req: Request): Promise<{ email: string }> {
    const token = asBody(body).token;
    const confirmed = typeof token === 'string' ? await this.marketing.confirm(token, { ip: req.ip }) : null;
    if (!confirmed) throw linkInvalid();
    return { email: maskEmail(confirmed.email) };
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter_unsubscribe')
  async unsubscribe(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const token = asBody(body).token;
    if (typeof token === 'string') await this.marketing.unsubscribeByToken(token, { ip: req.ip });
  }
}
