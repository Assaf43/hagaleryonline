import { createHash } from 'node:crypto';
import { scrub } from './scrub.js';

export interface FingerprintInput {
  kind: 'error' | 'warn';
  source: 'api' | 'ssr';
  message: string;
  stack?: string;
}

/** The message as grouped: scrubbed, every digit `#`, whitespace collapsed. */
export function normalizeMessage(message: string): string {
  return scrub(message).replace(/\d/g, '#').replace(/\s+/g, ' ').trim();
}

/** Where a project path starts inside an absolute one; node_modules wins (last one). */
const ROOT_DIRS = /\/(?:dist|src|apps|libs)\//;

function relativePath(path: string): string {
  const modules = path.lastIndexOf('/node_modules/');
  if (modules >= 0) return path.slice(modules + 1);
  const root = ROOT_DIRS.exec(path);
  if (root) return path.slice(root.index + 1);
  return path.slice(path.lastIndexOf('/') + 1);
}

/** An absolute path (`/srv/…`, `C:/…`, `/C:/…` after `file://`) not inside another path or `node:` name. */
const ABSOLUTE_PATH = /(?<![\w:./])\/?(?:[A-Za-z]:)?\/[^\s()]*/g;

/**
 * The first `at …` line of a stack, without `:line:col`, absolute path prefixes or bundle hashes
 * (`chunk-5XJ3K2QP.mjs`), so a rebuild or another server keeps the same group. Empty without one.
 */
export function firstFrame(stack: string | undefined): string {
  const line = stack
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^at\s/.test(l));
  if (!line) return '';
  return line
    .replace(/\\/g, '/')
    .replace(/file:\/\//g, '')
    .replace(/:\d+(?::\d+)?(?=\)|$)/g, '')
    .replace(ABSOLUTE_PATH, relativePath)
    .replace(/-[A-Z0-9]{8}(?=\.m?js\b)/g, '-#');
}

/** SHA-256 hex of `kind|source|normalized message|first frame` (spec 9b.6). */
export function fingerprint(input: FingerprintInput): string {
  const parts = [input.kind, input.source, normalizeMessage(input.message), firstFrame(input.stack)];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
