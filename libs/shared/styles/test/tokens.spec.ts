import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTokens, resolveAll, resolveTokens } from './resolve-tokens';

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

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

  it('component tokens', async () => {
    const t = await resolveAll();
    const expected: Record<string, string> = {
      '--control-height': '48px',
      '--control-height-compact': '40px',
      '--control-height-sm': '32px',
      '--icon-button-size': '44px',
      '--icon-size-xs': '14px',
      '--icon-size-sm': '16px',
      '--icon-size-md': '18px',
      '--icon-size-ui': '20px',
      '--icon-size-header': '24px',
      '--border-width': '1px',
      '--border-width-input': '1.5px',
      '--border-width-strong': '2px',
      '--focus-ring-width': '2px',
      '--focus-ring-offset': '2px',
      '--badge-padding-block': '2px',
      '--badge-padding-inline': '10px',
      '--swatch-size': '26px',
      '--swatch-ring': '2px',
      '--card-radius': '10px',
      '--media-radius': '10px',
      '--button-padding-inline': '24px',
    };
    for (const [name, value] of Object.entries(expected)) expect(t.light[name], name).toBe(value);
    expect(t['light@1024']['--control-height']).toBe('44px');
  });

  it('swatch border reaches 3:1 against the page background in both themes (WCAG 1.4.11)', async () => {
    const t = await resolveAll();
    for (const theme of ['light', 'dark'] as const) {
      const border = t[theme]['--swatch-border'];
      expect(border, theme).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(border, t[theme]['--color-bg']), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it('semantic file has no raw colors', () => {
    const text = readFileSync(new URL('../_tokens.scss', import.meta.url), 'utf8');
    expect(text).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(text).not.toMatch(/\brgba?\(/);
  });
});
