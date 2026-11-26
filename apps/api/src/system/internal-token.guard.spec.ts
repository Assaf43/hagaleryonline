import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InternalTokenGuard } from './internal-token.guard.js';

const TOKEN = 'internal-token-for-this-spec-0123456789';

function guardWith(configured: string | undefined) {
  const config = { get: (name: string) => (name === 'INTERNAL_API_TOKEN' ? configured : undefined) };
  return new InternalTokenGuard(config as unknown as ConfigService);
}

function ctx(header: string | string[] | undefined): ExecutionContext {
  const req = { method: 'POST', originalUrl: '/api/internal/error-events', headers: { 'x-internal-token': header } };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('InternalTokenGuard', () => {
  it('lets the right token in', () => {
    expect(guardWith(TOKEN).canActivate(ctx(TOKEN))).toBe(true);
  });

  it('answers 404 for a wrong token', () => {
    expect(() => guardWith(TOKEN).canActivate(ctx(`${TOKEN}x`))).toThrow(NotFoundException);
    expect(() => guardWith(TOKEN).canActivate(ctx('short'))).toThrow(NotFoundException);
  });

  it('answers 404 for a missing or repeated header', () => {
    expect(() => guardWith(TOKEN).canActivate(ctx(undefined))).toThrow(NotFoundException);
    expect(() => guardWith(TOKEN).canActivate(ctx([TOKEN, TOKEN]))).toThrow(NotFoundException);
  });

  it('answers 404 when no token is configured, even for an empty header', () => {
    expect(() => guardWith(undefined).canActivate(ctx(TOKEN))).toThrow(NotFoundException);
    expect(() => guardWith('').canActivate(ctx(''))).toThrow(NotFoundException);
    expect(() => guardWith('  ').canActivate(ctx('  '))).toThrow(NotFoundException);
  });

  it('looks like an unknown route', () => {
    try {
      guardWith(TOKEN).canActivate(ctx('nope'));
      expect.unreachable();
    } catch (error) {
      expect((error as NotFoundException).getResponse()).toMatchObject({
        message: 'Cannot POST /api/internal/error-events',
        error: 'Not Found',
        statusCode: 404,
      });
    }
  });
});
