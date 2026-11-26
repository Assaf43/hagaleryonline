import { scrub, stripQuery } from './server-scrub';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * One JSON line on stdout (NFR-11, spec 9b.6), the same shape as the API's: `level`, `time`, `msg` and the fields.
 * The message and every string field are scrubbed (e-mails, phones, tokens, cookies); a value under a secret name
 * (`password`, `t`, `code`…) is hidden whatever it looks like. Never throws.
 */
export function logJson(level: LogLevel, message: string, fields: Record<string, string | number> = {}): void {
  try {
    const record: Record<string, string | number> = {};
    for (const [key, raw] of Object.entries(fields)) record[key] = scrubField(key, raw);
    const line = JSON.stringify({ level, time: new Date().toISOString(), msg: scrub(String(message)), ...record });
    process.stdout.write(`${line}\n`);
  } catch {
    // A log line that cannot be written must never break a request.
  }
}

function scrubField(key: string, raw: string | number): string | number {
  const text = String(raw);
  const value = scrub(text);
  const pair = `{${JSON.stringify(key)}:${JSON.stringify(value)}}`;
  if (scrub(pair) !== pair) return '[redacted]';
  return typeof raw === 'number' && value === text ? raw : value;
}

interface ReportingTarget {
  apiUrl: string;
  internalToken: string;
}

let target: ReportingTarget = { apiUrl: '', internalToken: '' };

/** Where `reportServerError` posts (set once at startup from `readServerEnv`). */
export function configureReporting(next: ReportingTarget): void {
  target = next;
}

const REPORT_TIMEOUT_MS = 2000;

/**
 * Hands a server render error to the API's error screen (spec 9b.6): fire-and-forget, a 2 s timeout, never throws
 * and never waits. Does nothing when `INTERNAL_API_TOKEN` is unset. Message and stack are scrubbed here too, and the
 * path loses its query string.
 */
export function reportServerError(err: unknown, path: string): void {
  try {
    if (!target.internalToken) return;
    const error = err instanceof Error ? err : undefined;
    const message = error ? (error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message) : String(err);
    const body = JSON.stringify({
      kind: 'error',
      message: scrub(message),
      stack: error?.stack ? scrub(error.stack) : undefined,
      path: stripQuery(path),
    });
    fetch(`${target.apiUrl}/api/internal/error-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': target.internalToken },
      body,
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }).catch(() => undefined);
  } catch {
    // Reporting is best effort.
  }
}
