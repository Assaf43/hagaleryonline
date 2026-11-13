import { DEFAULT_NEXT, safeNext } from './next-url';

describe('safeNext', () => {
  it('accepts a same-site relative path, with query and fragment', () => {
    expect(safeNext('/account/orders/100001')).toBe('/account/orders/100001');
    expect(safeNext('/cart?x=1#top')).toBe('/cart?x=1#top');
    expect(safeNext('/')).toBe('/');
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    '/\\\\evil.example',
    'https://evil.example',
    'http://evil.example/account',
    'javascript:alert(1)',
    'account/orders',
    '',
    '/\t/evil.example',
    '/a\\b',
    '/a\nb',
  ])('falls back to the orders list for %j', (value) => {
    expect(safeNext(value)).toBe(DEFAULT_NEXT);
    expect(DEFAULT_NEXT).toBe('/account/orders');
  });

  it('falls back for a missing or non-string value', () => {
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(['/x'])).toBe(DEFAULT_NEXT);
  });
});
