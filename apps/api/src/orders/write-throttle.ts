import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { IpThrottle } from '../auth/login-throttle.js';
import { CheckoutError } from './order-errors.js';

/**
 * The public write endpoints that are rate limited per IP (a window of 15 minutes each). `lookup_number` and
 * `support_order` are keyed by the order number instead of the IP ("my order status" and the support requests about
 * an order, together with `lookup` / `support` per IP). `store_otp`, `store_lookup` and `store_verify` are keyed by the seller (`seller:<id>`): the
 * store's one public IP must never lock out sales (spec §4.3).
 */
export type ThrottleBucket =
  | 'checkout'
  | 'retry'
  | 'sandbox'
  | 'coupon'
  | 'cancel'
  | 'delivery'
  | 'otp'
  | 'signin'
  | 'account'
  | 'lookup'
  | 'lookup_number'
  | 'support'
  | 'support_order'
  | 'store_otp'
  | 'store_lookup'
  | 'store_verify';

const WINDOW_MS = 15 * 60_000;
/** Production defaults per key (mostly the IP) per 15 minutes; `THROTTLE_<BUCKET>_LIMIT` overrides (e2e raises them). */
const DEFAULT_LIMITS: Record<ThrottleBucket, number> = {
  checkout: 20,
  retry: 20,
  sandbox: 60,
  coupon: 20,
  cancel: 20,
  delivery: 20,
  // Customer accounts (Phase 5c, spec §6.2): code requests, and password / code attempts.
  otp: 10,
  signin: 20,
  // The account's own data (spec §6.3): saved addresses and marketing consent.
  account: 60,
  // "My order status" (spec §6.5): every attempt, per IP and per order number.
  lookup: 10,
  lookup_number: 5,
  // Support requests (spec §7.1): per IP, and returns / damaged products also per order number.
  support: 5,
  support_order: 5,
  // Store customer confirmation codes (Phase 6, spec §4.3): per seller, never per IP.
  store_otp: 30,
  // Store customer lookups (phone → name), per seller.
  store_lookup: 60,
  // Store code checks, per seller (every call, so their refusals are no unthrottled oracle).
  store_verify: 60,
};

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

  /**
   * Records a request; false when the key (the IP, the order number of `lookup_number` / `support_order`, or
   * `seller:<id>` of the `store_*` buckets) is over the bucket's limit.
   */
  allow(bucket: ThrottleBucket, key: string | undefined): boolean {
    return this.bucket(bucket).allow(key ?? 'unknown');
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

/** The `Retry-After` of a refused request (the whole window). */
export const THROTTLE_RETRY_AFTER_SECONDS = WINDOW_MS / 1000;

/** 429 `too_many_requests` with `Retry-After` (sets the header on `res`). */
export function tooManyRequests(res: Response): CheckoutError {
  res.setHeader('Retry-After', String(THROTTLE_RETRY_AFTER_SECONDS));
  return new CheckoutError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests', {
    retryAfterSeconds: THROTTLE_RETRY_AFTER_SECONDS,
  });
}

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
    throw tooManyRequests(http.getResponse<Response>());
  }
}
