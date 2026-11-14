import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import type { SupportTicketCreated } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import type { ResolvedCustomer } from '../customers/customer-session.service.js';
import { OptionalCustomer, OptionalCustomerGuard } from '../customers/customer-session.guard.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';
import { SupportPhotosInterceptor, type UploadedPhoto } from './attachments.js';
import { isHoneypot } from './support-input.js';
import { SupportService } from './support.service.js';

/** What a filled honeypot gets: the same 202, with nothing saved and no ticket number. */
type Accepted = SupportTicketCreated | Record<string, never>;

/**
 * Support requests (spec §7.1, SRV-02, SRV-03, SRV-05): `POST /api/support/returns`, `damaged` (multipart) and
 * `contact`. Storefront origin only; every request counts per IP in the `support` bucket (`THROTTLE_SUPPORT_LIMIT`,
 * 5 per 15 minutes) before anything else is read, the upload included. A filled honeypot `website` answers 202 `{}`
 * and saves nothing; an accepted request answers 202 `{ ticketNumber }`.
 */
@Controller('support')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard, OptionalCustomerGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('returns')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttled('support')
  async returns(
    @Body() body: unknown,
    @OptionalCustomer() customer: ResolvedCustomer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Accepted> {
    if (isHoneypot(body)) return {};
    return this.support.requestReturn(body, customer?.customer ?? null, res);
  }

  @Post('damaged')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttled('support')
  @UseInterceptors(SupportPhotosInterceptor)
  async damaged(
    @Body() body: unknown,
    @UploadedFiles() files: UploadedPhoto[] | undefined,
    @OptionalCustomer() customer: ResolvedCustomer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Accepted> {
    if (isHoneypot(body)) return {};
    return this.support.reportDamaged(body, files, customer?.customer ?? null, res);
  }

  @Post('contact')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttled('support')
  async contact(@Body() body: unknown, @OptionalCustomer() customer: ResolvedCustomer | null): Promise<Accepted> {
    if (isHoneypot(body)) return {};
    return this.support.contact(body, customer?.customer ?? null);
  }
}
