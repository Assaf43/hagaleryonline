import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Production builds put fonts under /static-media so that /media is only product photos (Phase 9b-2).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apps = ['storefront', 'admin'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

for (const app of apps) {
  const browser = join(root, 'apps', app, 'dist', app, 'browser');
  const built = existsSync(browser);
  if (!built) console.log(`[build-output] SKIPPED ${app}: ${browser} is not built (run npm run build -w @hg/${app})`);

  describe.skipIf(!built)(`${app} build output`, () => {
    it('has no media folder in the build output', () => {
      expect(existsSync(join(browser, 'media'))).toBe(false);
    });

    it('keeps the fonts under static-media', () => {
      const dir = join(browser, 'static-media');
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir).some((f) => /\.woff2?$/.test(f))).toBe(true);
    });

    it('points every CSS url() at static-media, never media', () => {
      const css = walk(browser).filter((f) => f.endsWith('.css'));
      expect(css.length).toBeGreaterThan(0);
      const urls = css.flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]),
      );
      const bad = urls.filter((u) => /(^|\/)media\//.test(u) && !/static-media\//.test(u));
      expect(bad).toEqual([]);
      expect(urls.some((u) => u.includes('static-media/'))).toBe(true);
    });
  });
}
