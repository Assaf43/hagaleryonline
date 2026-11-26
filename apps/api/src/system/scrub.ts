/**
 * Removes personal data and secrets from text before it is logged or stored (NFR-11, spec 9b.6).
 * Pure: the storefront SSR log keeps a copy of this file; both specs share
 * `scripts/fixtures/scrub-sentinels.json`, so keep the two in step.
 */

export const SCRUB_MAX_LENGTH = 2000;

/** Query parameters whose value is a secret (order token, preview token, codes, keys, signatures). */
const SECRET_QUERY_NAMES = ['t', 'token', 'preview', 'code', 'key', 'signature'];

/** `Cookie:` / `Set-Cookie:` header or JSON key: the whole value (to the end of the line or the closing quote). */
const COOKIE = /\b((?:set-)?cookie)(["']?\s*:\s*)("[^"\r\n]*"?|[^\r\n]*)/gi;
const BEARER = /\bBearer\s+[^\s"',;]+/gi;
/** Whole parameter names only: `?at=` or `&count=` are not touched. */
const SECRET_QUERY = new RegExp(`([?&](?:${SECRET_QUERY_NAMES.join('|')})=)[^&#\\s"'<>]*`, 'gi');
const PERSONAL_CODE = /\bNST-[A-Z0-9]{8}\b/gi;
/** Starts only at the beginning of a local-part run, so a long run without `@` is scanned once, not n² times. */
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Runs of base64url / hex characters; see `looksSecret` for which runs count. */
const TOKEN_RUN = /[A-Za-z0-9_-]{24,}/g;
/** Israeli mobile, local form: 05x and seven more digits, dashes or spaces allowed between digits. */
const LOCAL_MOBILE = /(?<![\w+])05\d(?:[- ]?\d){7}(?!\d)/g;
/** +972 (or 972) with an optional leading 0, a mobile (5x) or landline (2–9) prefix and seven digits. */
const INTERNATIONAL_PHONE = /(?<![\w+])\+?972[- ]?0?(?:5\d|[2-9])(?:[- ]?\d){7}(?!\d)/g;

/** Names whose value is a secret wherever they appear as a key: JSON, a Node object print or `name=value`. */
const SECRET_KEY_NAMES = [...SECRET_QUERY_NAMES, 'password', 'otp'];
/**
 * `"code":"…"`, `{ code: '…' }`, `code=…`: a whole name (not `zipcode`, `hg_token`, `apiKey`), optionally
 * quoted, then `:` or `=` and a quoted or bare value. A bare value never starts with `[`, so the markers
 * of earlier steps (`t=[redacted]`) are not matched again. Starts are anchored to a name, so it stays linear.
 */
const SECRET_KEY = new RegExp(
  String.raw`(?<![\w$.'"-])(["']?)(${SECRET_KEY_NAMES.join('|')})\1(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|(?!\[)[^\s,;&}\])]+)`,
  'gi',
);
/** A marker an earlier step wrote (`[code]`, `[secret]`, …). */
const MARKER = /^\[[a-z]+\]$/;
/** Error codes are not secrets: `P2002`, `ECONNREFUSED`, `ERR_X`, the API's own `price_changed`. */
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z_]*)$/;

function redactKey(match: string, quote: string, name: string, sep: string, value: string): string {
  const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
  const inner = q ? value.slice(1, -1) : value;
  if (MARKER.test(inner) || (name.toLowerCase() === 'code' && ERROR_CODE.test(inner))) return match;
  return `${quote}${name}${quote}${sep}${q}[redacted]${q}`;
}

/**
 * A run of ≥ 24 token characters is a secret when it holds a digit (every hex token, and almost
 * every random base64url one) or is ≥ 32 long (any 24-byte or longer random value). This keeps
 * long code names readable: `processTicksAndRejections`, `ERR_HTTP_HEADERS_ALREADY_SENT`.
 */
function looksSecret(run: string): boolean {
  return /\d/.test(run) || run.length >= 32;
}

/**
 * Replaces e-mails, phones, secret query values, bearer tokens, cookies, long tokens and personal
 * codes with fixed markers, then cuts the result to {@link SCRUB_MAX_LENGTH} characters.
 * The order matters: whole values (cookie, bearer, query) go first so a long token inside them is
 * redacted as one; e-mails go before token runs so no domain is left behind; secret keys go last, so a
 * value another step owns keeps its marker (`{"code":"[code]"}`).
 */
export function scrub(text: string): string {
  const out = text
    .replace(COOKIE, (_m, name: string, sep: string, value: string) =>
      value.startsWith('"') ? `${name}${sep}"[redacted]"` : `${name}${sep}[redacted]`,
    )
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_QUERY, '$1[redacted]')
    .replace(PERSONAL_CODE, '[code]')
    .replace(EMAIL, '[email]')
    .replace(TOKEN_RUN, (run) => (looksSecret(run) ? '[secret]' : run))
    .replace(INTERNATIONAL_PHONE, '[phone]')
    .replace(LOCAL_MOBILE, '[phone]')
    .replace(SECRET_KEY, redactKey);
  return out.length > SCRUB_MAX_LENGTH ? out.slice(0, SCRUB_MAX_LENGTH) : out;
}

/** The path of a path or URL: no scheme, host, query or fragment (`/` when nothing is left). */
export function stripQuery(pathOrUrl: string): string {
  const path = pathOrUrl
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^\/\/[^/?#]*/, '')
    .replace(/[?#][\s\S]*$/, '');
  return path || '/';
}
