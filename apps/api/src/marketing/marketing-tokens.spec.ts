import { resolveMarketingTokenSecret, UnsubscribeTokens } from './marketing-tokens.js';

describe('resolveMarketingTokenSecret', () => {
  it('production needs its own secret of at least 32 characters', () => {
    expect(() => resolveMarketingTokenSecret(undefined, 'production')).toThrow(/MARKETING_TOKEN_SECRET/);
    expect(() => resolveMarketingTokenSecret('short', 'production')).toThrow(/at least 32/);
    expect(resolveMarketingTokenSecret('x'.repeat(32), 'production')).toBe('x'.repeat(32));
  });

  it('dev and tests fall back to a fixed secret', () => {
    expect(resolveMarketingTokenSecret(undefined, 'development')).toBe(resolveMarketingTokenSecret('', undefined));
    expect(resolveMarketingTokenSecret('mine', undefined)).toBe('mine');
  });

  it('tokens depend on the secret', () => {
    expect(new UnsubscribeTokens('a').token('c-1')).not.toBe(new UnsubscribeTokens('b').token('c-1'));
  });
});
