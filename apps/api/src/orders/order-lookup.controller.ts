import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { OrderLookupResponse } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { OrderLookupService, lookupThrottleKey } from './order-lookup.service.js';
import { WriteThrottle, tooManyRequests } from './write-throttle.js';

/**
 * "My order status" (spec §6.5, SHP-05): `POST /api/orders/lookup { number, phone }` → `{ url }` of the order page,
 * or the one 404 of `lookupMiss()`. Every attempt, found or not, counts against two limits (15 minutes each): per IP
 * (`THROTTLE_LOOKUP_LIMIT`, 10) and per order number (`THROTTLE_LOOKUP_NUMBER_LIMIT`, 5), so neither many numbers
 * from one address nor one number from many addresses can be guessed through. Over either: 429 with `Retry-After`.
 */
@Controller('orders/lookup')
@UseGuards(StorefrontOriginGuard)
export class OrderLookupController {
  constructor(
    private readonly lookups: OrderLookupService,
    private readonly throttle: WriteThrottle,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async lookup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderLookupResponse> {
    // Set before anything can throw, so a match and a miss carry the same headers.
    res.setHeader('Cache-Control', 'no-store');
    const { number, phone } = (body ?? {}) as Record<string, unknown>;
    // Both are recorded on every attempt (no short-circuit).
    const ipAllowed = this.throttle.allow('lookup', req.ip);
    const numberAllowed = this.throttle.allow('lookup_number', lookupThrottleKey(number));
    if (!ipAllowed || !numberAllowed) throw tooManyRequests(res);
    return { url: await this.lookups.lookup(number, phone) };
  }
}
