import { readServerEnv } from './server-env';

describe('readServerEnv', () => {
  it('uses the defaults and keeps indexing off', () => {
    expect(readServerEnv({})).toEqual({
      apiUrl: 'http://localhost:3000',
      siteUrl: 'https://hagaleryonline.co.il',
      indexing: false,
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
});
