import { inspect } from 'node:util';
import { ConsoleLogger, Injectable, type LogLevel, Optional } from '@nestjs/common';
import { ErrorEventsService, topFrames, type ErrorEventKind } from './error-events.service.js';
import { RequestContext } from './request-context.js';
import { scrub, SCRUB_MAX_LENGTH } from './scrub.js';

/** JSON lines in production, or with `LOG_FORMAT=json`; Nest's readable format otherwise. */
export function jsonLogs(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.LOG_FORMAT === 'json';
}

/** `printAsJson`'s options (protected in `ConsoleLogger`). */
interface JsonPrintOptions {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, unknown>;
  error?: Error;
}

const MAX_DEPTH = 6;
/** A terminal color code; the text between codes is scrubbed piece by piece (`32mStoreOrdersAdminController` is no token). */
const ANSI_COLOR = new RegExp(String.raw`(\u001b\[[0-9;]*m)`);
const scrubColored = (text: string) =>
  text
    .split(ANSI_COLOR)
    .map((part, i) => (i % 2 === 1 ? part : scrub(part)))
    .join('');
const STACK_LINE = /\n[ \t]+at /;
const inspectOneLine = (value: unknown) => inspect(value, { depth: 3, breakLength: Infinity, compact: true });

/** A string scrubbed; a number kept unless its digits scrub (a phone), then the scrubbed text. */
function scrubAlone(raw: string | number): string | number {
  if (typeof raw === 'string') return scrub(raw);
  const text = String(raw);
  const out = scrub(text);
  return out === text ? raw : out;
}

/**
 * One value under `key`: scrubbed on its own, then as the JSON pair `{"key":value}` so a secret name (`password`,
 * `otp`, `t`…) also redacts it.
 */
function scrubEntry(key: string, raw: string | number): unknown {
  // The value on its own first: JSON inside a string is escaped in the pair (`{\"password\":…}`), and a number
  // that is a phone (`972501234567`) becomes `[phone]`.
  const value = scrubAlone(raw);
  if (typeof value === 'string' && typeof raw === 'number') return value;
  const pair = `{${JSON.stringify(key)}:${JSON.stringify(value)}}`;
  if (pair.length >= SCRUB_MAX_LENGTH) return value;
  const out = scrub(pair);
  if (out === pair) return value;
  try {
    return (JSON.parse(out) as Record<string, unknown>)[key];
  } catch {
    // A rule ate past the value (`cookie: …` runs to the end of the line): the value alone is already scrubbed,
    // so only a secret name still needs its value hidden.
    const probe = `{${JSON.stringify(key)}:"x1"}`;
    return scrub(probe) === probe ? value : '[redacted]';
  }
}

/** Every string (and every value under a secret name) of a log record, scrubbed; errors, maps and sets as text. */
function scrubDeep(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
  // A bigint is printed as its digits anyway (`stringifyReplacer`): scrub those like a string.
  const leaf = typeof value === 'bigint' ? value.toString() : value;
  if (typeof leaf === 'string' || typeof leaf === 'number')
    return key === undefined ? scrubAlone(leaf) : scrubEntry(key, leaf);
  if (typeof value === 'symbol') return scrub(value.toString());
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => scrubDeep(v, undefined, seen, depth + 1));
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return scrub(inspectOneLine(value));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, k, seen, depth + 1)] as const));
  } finally {
    seen.delete(value);
  }
}

/** The text and stack of a logged error or warning, from Nest's `(message, ...params)` call shapes. */
export function describeLogCall(message: unknown, params: unknown[]): { text: string; stack?: string } {
  const paramError = params.find((p): p is Error => p instanceof Error);
  if (message instanceof Error) {
    const text = message.name && message.name !== 'Error' ? `${message.name}: ${message.message}` : message.message;
    return { text, stack: message.stack };
  }
  const text = typeof message === 'string' ? message : inspectOneLine(message);
  if (paramError) return { text: `${text}: ${paramError.message}`, stack: paramError.stack };
  const stack = params.find((p): p is string => typeof p === 'string' && STACK_LINE.test(p));
  return { text, stack };
}

/**
 * The API's logger (spec 9b.6, NFR-11): JSON lines in production, and every line scrubbed (e-mails, phones, tokens,
 * cookies) before it is printed. `error`, `fatal` and `warn` are also handed to `ErrorEventsService.capture` with the
 * request path from `RequestContext`; Nest's exception filter logs unhandled (5xx) errors here, a 4xx
 * `HttpException` is answered without a log line. A log call made while capturing is printed but not captured, so a
 * failing capture can never loop. Works without `ErrorEventsService` too (plain `new AppLogger()`).
 */
@Injectable()
export class AppLogger extends ConsoleLogger {
  private capturing = false;

  constructor(@Optional() private readonly events?: ErrorEventsService) {
    super({ json: jsonLogs() });
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('error', message, optionalParams);
    super.error(message, ...optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('error', message, optionalParams);
    super.fatal(message, ...optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    this.capture('warn', message, optionalParams);
    super.warn(message, ...optionalParams);
  }

  private capture(kind: ErrorEventKind, message: unknown, params: unknown[]): void {
    if (!this.events || this.capturing) return;
    this.capturing = true;
    try {
      const { text, stack } = describeLogCall(message, params);
      this.events.capture({
        kind,
        source: 'api',
        message: text,
        stack: stack === undefined ? undefined : scrub(topFrames(stack)),
        path: RequestContext.current()?.path,
      });
    } catch {
      // Logging goes on without the event.
    } finally {
      this.capturing = false;
    }
  }

  /** Text mode: the finished line, scrubbed (around its color codes). */
  protected override formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
    params?: Record<string, unknown>,
  ): string {
    const line = super.formatMessage(
      logLevel,
      message,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
      params,
    );
    return `${scrubColored(line.replace(/\n$/, ''))}\n`;
  }

  /** Text mode: the stack printed after an error line, scrubbed. */
  protected override printStackTrace(stack: string): void {
    super.printStackTrace(typeof stack === 'string' ? scrub(stack) : stack);
  }

  /** JSON mode: every string of the record scrubbed before it is serialized, so the printed line stays valid JSON. */
  protected override printAsJson(message: unknown, options: JsonPrintOptions): void {
    const record = scrubDeep(this.getJsonLogObject(message, options), undefined, new WeakSet(), 0) as Record<
      string,
      unknown
    >;
    process[options.writeStreamType ?? 'stdout'].write(`${this.stringifyJsonLogObject(record)}\n`);
  }
}
