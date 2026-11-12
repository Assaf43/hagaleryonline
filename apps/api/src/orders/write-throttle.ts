import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { IpThrottle } from '../auth/login-throttle.js';
import { CheckoutError } from './order-errors.js';

/** The public write endpoints that are rate limited per IP (a window of 15 minutes each). */
export type ThrottleBucket = 'checkout' | 'retry' | 'sandbox' | 'coupon';

const WINDOW_MS = 15 * 60_000;
/** Production defaults per IP per 15 minutes; `THROTTLE_<BUCKET>_LIMIT` overrides (e2e raises them). */
const DEFAULT_LIMITS: Record<ThrottleBucket, number> = { checkout: 20, retry: 20, sandbox: 60, coupon: 20 };

/**
 * Per-IP limits of the public writes that reserve stock or open payments (NFR-12): without them a script could hold
 * the whole stock with cookie-less carts. Coupon entry is limited too: its distinct answers would otherwise let a
 * script enumerate codes. The signed webhook is deliberately not throttled (a dropped retry of a
 * real provider would lose a payment); its signature is the check.
 */
@Injectable()
export class WriteThrottle {
  private readonly buckets = new Map<ThrottleBucket, IpThrottle>();

  constructor(private readonly config: ConfigService) {}

  /** Records a request; false when the IP is over the bucket's limit. */
  allow(bucket: ThrottleBucket, ip: string | undefined): boolean {
    return this.bucket(bucket).allow(ip ?? 'unknown');
  }

  /** Replaces a bucket with a fresh one of this limit (tests). */
  setLimit(bucket: ThrottleBucket, limit: number): void {
    this.buckets.set(bucket, new IpThrottle(limit, WINDOW_MS));
  }

  private bucket(name: ThrottleBucket): IpThrottle {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      const configured = Number(this.config.get<string>(`THROTTLE_${name.toUpperCase()}_LIMIT`));
      bucket = new IpThrottle(
        Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_LIMITS[name],
        WINDOW_MS,
      );
      this.buckets.set(name, bucket);
    }
    return bucket;
  }
}

const KEY = 'writeThrottleBucket';
/** Marks a handler with the bucket its requests are counted in (needs `WriteThrottleGuard`). */
export const Throttled = (bucket: ThrottleBucket) => SetMetadata(KEY, bucket);

/** 429 `too_many_requests` with `Retry-After` when the IP is over the limit of the handler's bucket. */
@Injectable()
export class WriteThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly throttle: WriteThrottle,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const bucket = this.reflector.get<ThrottleBucket | undefined>(KEY, ctx.getHandler());
    if (!bucket) return true;
    const http = ctx.switchToHttp();
    if (this.throttle.allow(bucket, http.getRequest<Request>().ip)) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(WINDOW_MS / 1000));
    throw new CheckoutError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests', { retryAfterSeconds: WINDOW_MS / 1000 });
  }
}
