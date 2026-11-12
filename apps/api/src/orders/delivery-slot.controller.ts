import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { DeliveryLinkView } from '@hg/models';
import type { Request } from 'express';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { DeliverySlotService } from './delivery-slot.service.js';
import { Throttled, WriteThrottleGuard } from './write-throttle.js';

/** The delivery confirmation page's API (spec §5.3). The token in the URL is the only key; POSTs need the storefront origin. */
@Controller('delivery')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard)
export class DeliverySlotController {
  constructor(private readonly slots: DeliverySlotService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  view(@Param('token') token: string): Promise<DeliveryLinkView> {
    return this.slots.view(token);
  }

  @Post(':token')
  @Header('Cache-Control', 'no-store')
  @Throttled('delivery')
  answer(@Param('token') token: string, @Body() body: unknown, @Req() req: Request): Promise<DeliveryLinkView> {
    return this.slots.answer(token, body, req.ip);
  }
}
