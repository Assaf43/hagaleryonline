/**
 * Express `trust proxy` from `TRUST_PROXY`: which hops in front of the API may set the client IP (X-Forwarded-For).
 * The per-IP limits (login, checkout, retry, sandbox) and the audit log key on that IP, so it must be the real
 * customer's: in production Caddy runs in its own container and calls from the Docker network, not from loopback —
 * set its subnet (e.g. `loopback, 172.18.0.0/16`) or a hop count (`1`). Otherwise every customer shares Caddy's IP
 * and one bucket. Empty → `loopback` (the dev servers). "Trust everyone" is refused: any client could then pick its
 * own IP and slip past the limits.
 */
export function trustProxySetting(value: string | undefined): string | number | string[] {
  const raw = value?.trim() ?? '';
  if (!raw) return 'loopback';
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === '*')
    throw new Error('TRUST_PROXY must name the proxy (subnet, "loopback") or a hop count, never every hop.');
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
