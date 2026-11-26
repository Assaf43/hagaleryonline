import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { ErrorEventKind } from './error-events.service.js';
import { stripQuery } from './scrub.js';

/** A report body over this size is refused (413). */
export const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_PATH = 500;

export interface InternalErrorInput {
  kind: ErrorEventKind;
  message: string;
  stack?: string;
  path?: string;
}

/**
 * The body of `POST /api/internal/error-events`: `kind` (`error` default, or `warn`), `message` (required),
 * `stack`, `path` (its query string is cut). Fields are cut to their limits; anything else, `source` included,
 * is ignored (the controller forces `ssr`).
 */
export function parseInternalError(body: unknown): InternalErrorInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('invalid_body');
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new PayloadTooLargeException('too_large');
  const input = body as Record<string, unknown>;
  const kind = input['kind'] ?? 'error';
  if (kind !== 'error' && kind !== 'warn') throw new BadRequestException('invalid_kind');
  const message = input['message'];
  if (typeof message !== 'string' || !message) throw new BadRequestException('invalid_message');
  const out: InternalErrorInput = { kind, message: message.slice(0, MAX_MESSAGE) };
  for (const name of ['stack', 'path'] as const) {
    const value = input[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new BadRequestException(`invalid_${name}`);
    out[name] = name === 'stack' ? value.slice(0, MAX_STACK) : stripQuery(value).slice(0, MAX_PATH);
  }
  return out;
}
