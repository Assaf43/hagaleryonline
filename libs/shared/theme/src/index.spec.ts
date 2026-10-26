import { describe, expect, it } from 'vitest';
import { effectiveTheme, readThemeCookie, saveTheme } from './index.js';

describe('readThemeCookie', () => {
  it('finds the saved theme among other cookies', () => {
    expect(readThemeCookie('a=1; hg-theme=dark; b=2')).toBe('dark');
  });

  it('ignores missing or invalid values', () => {
    expect(readThemeCookie(undefined)).toBeNull();
    expect(readThemeCookie('hg-theme=purple')).toBeNull();
  });
});

describe('effectiveTheme', () => {
  it('prefers the saved choice over the device setting', () => {
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme(null, true)).toBe('dark');
    expect(effectiveTheme(null, false)).toBe('light');
  });
});

describe('saveTheme', () => {
  it('sets the attribute and a one-year cookie', () => {
    const attrs: Record<string, string> = {};
    const doc = {
      cookie: '',
      documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
    } as unknown as Document;
    saveTheme(doc, 'dark');
    expect(attrs['data-theme']).toBe('dark');
    expect(doc.cookie).toContain('hg-theme=dark');
    expect(doc.cookie).toContain('Max-Age=31536000');
  });
});
