import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTokens, resolveTokens } from './resolve-tokens';

describe('design tokens', () => {
  it('semantic tokens resolve to the v2 values', async () => {
    expect(await resolveTokens()).toMatchSnapshot();
  });

  it('dark theme overrides every color token', async () => {
    const { root, dark } = parseTokens();
    const colors = (d: Record<string, string>) =>
      Object.keys(d)
        .filter((k) => k.startsWith('--color-'))
        .sort();
    expect(colors(dark)).toEqual(colors(root));
    const tokens = await resolveTokens();
    expect(tokens.dark['color-scheme']).toBe('dark');
    expect(tokens.light['color-scheme']).toBe('light');
  });

  it('desktop type scale', async () => {
    const t = await resolveTokens();
    expect(t['light@1024']['--font-h1']).toBe('36px');
    expect(t['light@1024']['--font-display']).toBe('48px');
    expect(t['light@1024']['--gutter']).toBe('32px');
    expect(t['light@768']['--gutter']).toBe('24px');
    expect(t.light['--font-h1']).toBe('26px');
  });

  it('focus ring token', async () => {
    const t = await resolveTokens();
    expect(t.light['--color-focus-ring']).toBe('#111111');
    expect(t.dark['--color-focus-ring']).toBe('#f2f2f2');
  });

  it('semantic file has no raw colors', () => {
    const text = readFileSync(new URL('../_tokens.scss', import.meta.url), 'utf8');
    expect(text).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(text).not.toMatch(/\brgba?\(/);
  });
});
