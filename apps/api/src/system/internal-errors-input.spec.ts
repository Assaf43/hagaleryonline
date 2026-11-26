import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { parseInternalError, MAX_BODY_BYTES } from './internal-errors-input.js';

describe('parseInternalError', () => {
  it('defaults the kind to error and cuts every field', () => {
    const out = parseInternalError({
      message: 'm'.repeat(3000),
      stack: 's'.repeat(9000),
      path: `/${'p'.repeat(700)}`,
    });
    expect(out.kind).toBe('error');
    expect(out.message).toHaveLength(2000);
    expect(out.stack).toHaveLength(8000);
    expect(out.path).toHaveLength(500);
  });

  it('takes kind warn, refuses anything else', () => {
    expect(parseInternalError({ kind: 'warn', message: 'x' }).kind).toBe('warn');
    expect(() => parseInternalError({ kind: 'fatal', message: 'x' })).toThrow(BadRequestException);
  });

  it('strips the query string of the path', () => {
    expect(parseInternalError({ message: 'x', path: '/order/5001?t=abc#h' }).path).toBe('/order/5001');
  });

  it('needs a non-empty string message and rejects non-objects', () => {
    for (const body of [undefined, null, 'x', 5, [], {}, { message: '' }, { message: 7 }, { message: 'x', stack: 4 }]) {
      expect(() => parseInternalError(body), JSON.stringify(body)).toThrow(BadRequestException);
    }
  });

  it('refuses a body over 16 KB', () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
    expect(() => parseInternalError({ message: 'x', stack: 'a'.repeat(MAX_BODY_BYTES) })).toThrow(
      PayloadTooLargeException,
    );
  });

  it('ignores a source or any other field the caller sends', () => {
    const out = parseInternalError({ message: 'x', source: 'api', extra: 1 }) as unknown as Record<string, unknown>;
    expect(out['source']).toBeUndefined();
    expect(out['extra']).toBeUndefined();
  });
});
