import { Module } from '@nestjs/common';
import { WriteThrottle, WriteThrottleGuard } from './write-throttle.js';

/** One WriteThrottle for the whole API (per-IP buckets), shared by the orders and cart modules. */
@Module({
  providers: [WriteThrottle, WriteThrottleGuard],
  exports: [WriteThrottle, WriteThrottleGuard],
})
export class WriteThrottleModule {}
