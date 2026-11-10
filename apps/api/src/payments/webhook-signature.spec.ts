import { createHmac } from 'node:crypto';
import { sign, verify } from './webhook-signature.js';

describe('webhook signature (HMAC-SHA256, spec §5.3)', () => {
  const secret = 'sandbox-secret';
  const body = JSON.stringify({ transactionId: 'sbx_1', status: 'succeeded', amount: 123_400, installments: 3 });

  it('signs as lower-case hex HMAC-SHA256 of the raw body', () => {
    expect(sign(body, secret)).toBe(createHmac('sha256', secret).update(body).digest('hex'));
    expect(sign(body, secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies its own signature, also in upper case', () => {
    expect(verify(body, sign(body, secret), secret)).toBe(true);
    expect(verify(body, sign(body, secret).toUpperCase(), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = sign(body, secret);
    expect(verify(body.replace('123400', '1'), signature, secret)).toBe(false);
    expect(verify(`${body} `, signature, secret)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(body, sign(body, 'other-secret'), secret)).toBe(false);
  });

  it('rejects missing, malformed or wrong-length signatures without throwing', () => {
    const signature = sign(body, secret);
    for (const bad of [undefined, '', 'abc', signature.slice(0, 63), `${signature}00`, 'z'.repeat(64), ['x']])
      expect(verify(body, bad, secret)).toBe(false);
  });

  it('never accepts anything with an empty secret', () => {
    expect(verify(body, sign(body, ''), '')).toBe(false);
  });
});
