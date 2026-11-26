import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { logJson } from '../apps/storefront/src/server-log.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_SCRUB = join(root, 'apps/api/src/system/scrub.ts');
const STOREFRONT_SCRUB = join(root, 'apps/storefront/src/server-scrub.ts');
const SENTINELS = JSON.parse(readFileSync(join(root, 'scripts/fixtures/scrub-sentinels.json'), 'utf8'));

/** The file without its leading header comment (the two headers differ on purpose). */
const body = (path) =>
  readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    .trim();

describe('storefront copy of scrub', () => {
  it('has the same code as the API file', () => {
    expect(body(STOREFRONT_SCRUB)).toBe(body(API_SCRUB));
  });

  it('logJson scrubs every sentinel of the shared table', () => {
    expect(SENTINELS.length).toBeGreaterThan(10);
    for (const s of SENTINELS) {
      const lines = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
      try {
        logJson('error', s.input);
      } finally {
        spy.mockRestore();
      }
      for (const bad of s.mustNotContain) expect(lines.join(''), s.name).not.toContain(bad);
    }
  });
});
