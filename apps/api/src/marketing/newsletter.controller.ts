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

/**
 * The newsletter (spec §4.4, §6, MKT-01, CLB-02, decision 95): `POST /api/newsletter` asks for a confirmation link
 * and answers 202 `{}` whether or not the address is known, subscribed or over its daily limit (nothing to probe);
 * `confirm` and `unsubscribe` are the calls of the link pages. Storefront origin only; all three count in the
 * `newsletter` bucket per IP (`THROTTLE_NEWSLETTER_LIMIT`) and are never cached. A filled honeypot `website` answers
 * 202 `{}` and saves nothing.
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

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter')
  async confirm(@Body() body: unknown, @Req() req: Request): Promise<{ email: string }> {
    const token = asBody(body).token;
    const confirmed = typeof token === 'string' ? await this.marketing.confirm(token, { ip: req.ip }) : null;
    if (!confirmed) throw new NotFoundException({ statusCode: 404, code: 'link_invalid' });
    return { email: maskEmail(confirmed.email) };
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @Throttled('newsletter')
  async unsubscribe(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const token = asBody(body).token;
    if (typeof token === 'string') await this.marketing.unsubscribeByToken(token, { ip: req.ip });
  }
}
