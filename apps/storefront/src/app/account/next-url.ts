/** Where a sign-in goes when `?next=` is missing or not safe. */
export const DEFAULT_NEXT = '/account/orders';

/**
 * `?next=` is accepted only as a same-site relative path: it starts with "/" and not "//" or "/\", and has no
 * backslash or control character anywhere (browsers read "/\evil.example" and "/<tab>/evil.example" as another
 * site). Anything else goes to the orders list, so a sign-in link can never send the customer to another site.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NEXT;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return DEFAULT_NEXT;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || code <= 0x1f || code === 0x7f) return DEFAULT_NEXT;
  }
  return value;
}
