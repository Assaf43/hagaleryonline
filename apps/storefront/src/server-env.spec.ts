import { readServerEnv, warnUnknownCsp } from './server-env';

describe('readServerEnv', () => {
  it('uses the defaults and keeps indexing off', () => {
    expect(readServerEnv({})).toEqual({
      apiUrl: 'http://localhost:3000',
      siteUrl: 'https://hagaleryonline.co.il',
      indexing: false,
      csp: 'off',
      internalToken: '',
    });
  });

  it('treats empty values as unset', () => {
    expect(readServerEnv({ API_URL: '', SITE_URL: '' }).apiUrl).toBe('http://localhost:3000');
  });

  it('trims one trailing slash', () => {
    const env = readServerEnv({ API_URL: 'http://api:3000/', SITE_URL: 'https://example.co.il/' });
    expect(env.apiUrl).toBe('http://api:3000');
    expect(env.siteUrl).toBe('https://example.co.il');
  });

  it("turns indexing on only for exactly 'true'", () => {
    expect(readServerEnv({ SEO_INDEXING: 'true' }).indexing).toBe(true);
    for (const v of ['TRUE', '1', 'yes', 'false', '']) expect(readServerEnv({ SEO_INDEXING: v }).indexing).toBe(false);
  });

  it('enforces the CSP by default in production and turns it off elsewhere', () => {
    expect(readServerEnv({ NODE_ENV: 'production' }).csp).toBe('enforce');
    expect(readServerEnv({ NODE_ENV: 'development' }).csp).toBe('off');
    expect(readServerEnv({}).csp).toBe('off');
  });

  it('takes STOREFRONT_CSP when it is a known mode', () => {
    for (const mode of ['enforce', 'report-only', 'off'] as const) {
      expect(readServerEnv({ STOREFRONT_CSP: mode }).csp).toBe(mode);
      expect(readServerEnv({ STOREFRONT_CSP: mode, NODE_ENV: 'production' }).csp).toBe(mode);
    }
  });

  it('falls back to the default for an empty or unknown STOREFRONT_CSP', () => {
    expect(readServerEnv({ STOREFRONT_CSP: '', NODE_ENV: 'production' }).csp).toBe('enforce');
    expect(readServerEnv({ STOREFRONT_CSP: 'report_only', NODE_ENV: 'production' }).csp).toBe('enforce');
    expect(readServerEnv({ STOREFRONT_CSP: 'ENFORCE' }).csp).toBe('off');
  });
});

describe('readServerEnv, internal token and CSP hint', () => {
  it('reads INTERNAL_API_TOKEN once, empty when unset', () => {
    expect(readServerEnv({}).internalToken).toBe('');
    expect(readServerEnv({ INTERNAL_API_TOKEN: 'abc' }).internalToken).toBe('abc');
  });

  it('warns once at startup (warnUnknownCsp) for an unknown STOREFRONT_CSP, without the value', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      // Renders call readServerEnv() many times: it stays silent.
      for (let i = 0; i < 3; i++) readServerEnv({ STOREFRONT_CSP: 'enforse-typo' });
      expect(lines).toHaveLength(0);
      warnUnknownCsp({ STOREFRONT_CSP: 'enforse-typo' });
      warnUnknownCsp({ STOREFRONT_CSP: 'enforce' });
      warnUnknownCsp({});
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn' });
    expect(lines[0]).not.toContain('enforse-typo');
  });
});
