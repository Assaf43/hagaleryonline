import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';

/** Personal answers (account, cart with member pricing) are never cached by a shared cache. */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    ctx.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}
