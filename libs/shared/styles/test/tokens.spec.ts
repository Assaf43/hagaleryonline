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
});
