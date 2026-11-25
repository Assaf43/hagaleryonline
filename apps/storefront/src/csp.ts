/** Sources a later phase may add to the storefront policy (9e: the tag manager). Nothing passes it in 9a. */
export type CspExtra = Partial<Record<'script-src' | 'connect-src' | 'img-src' | 'frame-src', string[]>>;

/**
 * The storefront Content-Security-Policy (NFR-07). Inline scripts and <style> tags need the per-request nonce,
 * which Angular puts on everything it renders (CSP_NONCE). `style-src-attr 'unsafe-inline'` is deliberate: the
 * server render writes `style=""` attributes from bindings, and a nonce cannot cover attributes. `base-uri 'self'`,
 * not 'none': index.html has `<base href="/">`, and without it every relative asset (main-*.js, chunk-*.js,
 * styles-*.css) on a deep page such as /product/x resolves under /product/ and 404s.
 */
export function buildStorefrontCsp(nonce: string, extra: CspExtra = {}): string {
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`]],
    ['style-src', ["'self'", `'nonce-${nonce}'`]],
    ['style-src-attr', ["'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    ['form-action', ["'self'"]],
    ['manifest-src', ["'self'"]],
  ];
  return directives
    .map(([name, sources]) => [name, ...sources, ...(extra[name as keyof CspExtra] ?? [])].join(' '))
    .join('; ');
}
