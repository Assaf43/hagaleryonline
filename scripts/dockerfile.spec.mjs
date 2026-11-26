import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 9b.1: one multi-target Dockerfile (app, caddy, backup).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');

/** Dockerfile instructions with `\` continuations joined and comments dropped. */
function instructions(text) {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  return lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Stages in order: { name, image, body: instruction[] }. */
function stages(text) {
  const out = [];
  for (const line of instructions(text)) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      out.push({ image: from[1], name: (from[2] ?? '').toLowerCase(), body: [] });
    } else if (out.length) {
      out.at(-1).body.push(line);
    }
  }
  return out;
}

// name:<x.y.z>[-suffix]@sha256:<64 hex> — an exact version, plus the digest it was checked with.
const PINNED = /^[a-z0-9./-]+:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?@sha256:[0-9a-f]{64}$/;
const SECRET_NAME = /SECRET|KEY|PASSWORD|TOKEN/i;

describe('Dockerfile', () => {
  const text = read('Dockerfile');
  const all = stages(text);
  const names = new Set(all.map((s) => s.name));

  it('exists and has the three targets', () => {
    expect(text).not.toBe('');
    for (const target of ['app', 'caddy', 'backup']) expect(names.has(target)).toBe(true);
  });

  it('pins every external FROM to an exact version and digest', () => {
    const external = all.filter((s) => !names.has(s.image.toLowerCase()));
    expect(external.length).toBeGreaterThan(0);
    for (const s of external) {
      expect(s.image, s.image).toMatch(PINNED);
      expect(s.image).not.toMatch(/:latest\b/);
    }
  });

  it('pins the caddy-ratelimit plugin to an exact version', () => {
    expect(text).toMatch(/--with github\.com\/mholt\/caddy-ratelimit@v\d+\.\d+\.\d+(?:-[0-9a-f.-]+)?\s/);
  });

  it('runs every runtime stage as node', () => {
    for (const target of ['app', 'backup']) {
      const stage = all.find((s) => s.name === target);
      const users = stage.body.filter((l) => /^USER\s/i.test(l));
      expect(users.at(-1), target).toMatch(/^USER\s+node$/i);
    }
  });

  it('has no ARG or ENV that looks like a secret, and only APP_VERSION as a build arg', () => {
    const lines = instructions(text);
    const declared = lines
      .filter((l) => /^(ARG|ENV)\s/i.test(l))
      .flatMap((l) =>
        l
          .replace(/^(ARG|ENV)\s+/i, '')
          .split(/\s+/)
          .map((pair) => pair.split('=')[0])
          .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)),
      );
    for (const name of declared) expect(name).not.toMatch(SECRET_NAME);
    const args = lines.filter((l) => /^ARG\s/i.test(l)).map((l) => l.replace(/^ARG\s+/i, '').split('=')[0]);
    expect(new Set(args)).toEqual(new Set(['APP_VERSION']));
  });

  it('starts the API by default', () => {
    const app = all.find((s) => s.name === 'app');
    expect(app.body.filter((l) => /^CMD\s/i.test(l)).at(-1)).toBe('CMD ["node", "apps/api/dist/main.js"]');
  });
});

describe('.dockerignore', () => {
  const lines = read('.dockerignore')
    .split(/\r?\n/)
    .map((l) => l.trim());

  it('keeps env files, secrets and local state out of the build context', () => {
    for (const entry of [
      '.env*',
      '.git',
      '**/node_modules',
      '**/dist',
      'storage/',
      '.angular',
      '.superpowers',
      'HANDOFF.md',
      '.claude',
      'deploy/rehearsal/.env.rehearsal',
    ]) {
      expect(lines, entry).toContain(entry);
    }
  });
});
