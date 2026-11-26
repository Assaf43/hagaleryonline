import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/**
 * The shared secret between the storefront server and the API (`INTERNAL_API_TOKEN`, header `X-Internal-Token`).
 * A wrong or missing token, or no token configured at all, answers exactly what an unknown route answers (404
 * `Cannot POST …`), so the route looks absent. Both sides are hashed first, so the constant-time compare never
 * sees different lengths and the length of the secret is not revealed.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const configured = (this.config.get<string>('INTERNAL_API_TOKEN') ?? '').trim();
    const sent = req.headers['x-internal-token'];
    if (configured && typeof sent === 'string' && timingSafeEqual(sha256(configured), sha256(sent.trim()))) {
      return true;
    }
    throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
  }
}
