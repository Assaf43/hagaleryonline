import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['generated', 'dist', 'node_modules']);
const OLD_NAMES = ['הגלריה לכולם', 'HaGalery', 'Hagalery'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sourceRoots() {
  const roots = [];
  for (const group of ['apps', 'libs/shared']) {
    const base = join(root, group);
    for (const name of readdirSync(base)) {
      const src = join(base, name, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        /* no src folder */
      }
    }
  }
  return roots;
}

describe('brand name', () => {
  it('the old site name appears nowhere in app source (it is written once, in BRAND)', () => {
    const offenders = [];
    for (const dir of sourceRoots()) {
      for (const file of walk(dir)) {
        let text;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (OLD_NAMES.some((n) => text.includes(n))) offenders.push(relative(root, file).split(sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
