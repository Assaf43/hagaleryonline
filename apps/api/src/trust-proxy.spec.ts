import { trustProxySetting } from './trust-proxy.js';

describe('trustProxySetting (TRUST_PROXY)', () => {
  it('defaults to loopback (the dev servers proxy from the same machine)', () => {
    expect(trustProxySetting(undefined)).toBe('loopback');
    expect(trustProxySetting('')).toBe('loopback');
    expect(trustProxySetting('   ')).toBe('loopback');
  });

  it('takes a hop count as a number', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
  });

  it('takes names and subnets as a list (e.g. the Docker network Caddy calls from)', () => {
    expect(trustProxySetting('loopback, 172.18.0.0/16')).toEqual(['loopback', '172.18.0.0/16']);
    expect(trustProxySetting('uniquelocal')).toEqual(['uniquelocal']);
  });

  it('refuses "true": trusting every hop lets any client choose its own IP and dodge the per-IP limits', () => {
    expect(() => trustProxySetting('true')).toThrow(/TRUST_PROXY/);
    expect(() => trustProxySetting('*')).toThrow(/TRUST_PROXY/);
  });
});
