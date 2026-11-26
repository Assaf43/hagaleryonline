import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, SCRUB_MAX_LENGTH, stripQuery } from './scrub.js';

interface Sentinel {
  name: string;
  input: string;
  mustNotContain: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
/** Shared with the storefront copy of scrub (one table for both). */
const SENTINELS = JSON.parse(
  readFileSync(join(here, '../../../../scripts/fixtures/scrub-sentinels.json'), 'utf8'),
) as Sentinel[];

describe('scrub', () => {
  it('scrubs e-mail, phone, token query, bearer, cookie', () => {
    expect(SENTINELS.length).toBeGreaterThan(10);
    for (const s of SENTINELS) {
      const out = scrub(s.input);
      for (const bad of s.mustNotContain) expect(out, s.name).not.toContain(bad);
    }
  });

  it('uses fixed markers', () => {
    expect(scrub('to sentinel.user@example.test')).toBe('to [email]');
    expect(scrub('SMS to 054-1234567 failed')).toBe('SMS to [phone] failed');
    expect(scrub('SMS to +972 54 765 4321 failed')).toBe('SMS to [phone] failed');
    expect(scrub('/order/5?t=abc&x=1')).toBe('/order/5?t=[redacted]&x=1');
    expect(scrub('/x?a=1&token=xyz')).toBe('/x?a=1&token=[redacted]');
    expect(scrub('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(scrub('Cookie: a=b; c=d\nok')).toBe('Cookie: [redacted]\nok');
    expect(scrub('Set-Cookie: a=b; Path=/')).toBe('Set-Cookie: [redacted]');
    expect(scrub('id 0123456789abcdef0123456789abcdef!')).toBe('id [secret]!');
    expect(scrub('code NST-ABCD2345 used')).toBe('code [code] used');
  });

  it('redacts only whole query parameter names', () => {
    expect(scrub('/x?at=1&count=3&tokens=2&keyword=sofa')).toBe('/x?at=1&count=3&tokens=2&keyword=sofa');
  });

  it('redacts a long token inside a query value or a bearer as a whole', () => {
    const hex = 'ab'.repeat(32);
    expect(scrub(`/delivery?t=${hex}`)).toBe('/delivery?t=[redacted]');
    expect(scrub(`Bearer ${hex}`)).toBe('Bearer [redacted]');
  });

  it('does not re-match its own markers', () => {
    const once = scrub('a sentinel.user@example.test b 054-1234567 c Bearer x d ?t=y');
    expect(scrub(once)).toBe(once);
  });

  it('keeps ordinary text', () => {
    expect(scrub('Order 100013 not found')).toBe('Order 100013 not found');
    expect(scrub('Variant 42 stock 3 of 12, total 1500000 agorot')).toBe(
      'Variant 42 stock 3 of 12, total 1500000 agorot',
    );
    expect(scrub('at process.processTicksAndRejections (node:internal/process/task_queues:105:5)')).toBe(
      'at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    );
    expect(scrub('ERR_HTTP_HEADERS_ALREADY_SENT')).toBe('ERR_HTTP_HEADERS_ALREADY_SENT');
    expect(scrub('2026-11-26T10:00:00.000Z')).toBe('2026-11-26T10:00:00.000Z');
  });

  it('stays linear on long input', () => {
    const started = performance.now();
    for (const s of ['a'.repeat(200_000), 'a.'.repeat(100_000), '0'.repeat(200_000), '05 '.repeat(60_000)]) scrub(s);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('cuts the result to 2 000 characters after scrubbing', () => {
    expect(SCRUB_MAX_LENGTH).toBe(2000);
    expect(scrub('x '.repeat(3000))).toHaveLength(2000);
    // A long e-mail list shrinks to markers before the cut, so nothing is half-cut.
    const many = Array.from({ length: 200 }, (_, i) => `user${i}@example.test`).join(' ');
    const out = scrub(many);
    expect(out).not.toContain('@');
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});

describe('stripQuery', () => {
  it('returns the path only', () => {
    expect(stripQuery('/order/100013?t=abc#x')).toBe('/order/100013');
    expect(stripQuery('/order/100013#x')).toBe('/order/100013');
    expect(stripQuery('https://shop.example.test:8443/product/alba?color=beige')).toBe('/product/alba');
    expect(stripQuery('//cdn.example.test/media/a.webp?v=1')).toBe('/media/a.webp');
    expect(stripQuery('https://shop.example.test')).toBe('/');
    expect(stripQuery('/plain')).toBe('/plain');
    expect(stripQuery('?t=abc')).toBe('/');
  });
});
