import { normalizeEmail, normalizePhone, normalizeTarget } from './contact-normalize.js';

describe('normalizePhone (spec §3: stored normalized 05XXXXXXXX)', () => {
  it('keeps a plain mobile number', () => {
    expect(normalizePhone('0501234567')).toBe('0501234567');
  });

  it('removes spaces and dashes', () => {
    expect(normalizePhone(' 050-123 4567 ')).toBe('0501234567');
    expect(normalizePhone('050-123-45-67')).toBe('0501234567');
  });

  it('turns +9725… into 05…', () => {
    expect(normalizePhone('+972501234567')).toBe('0501234567');
    expect(normalizePhone('+972-50-123-4567')).toBe('0501234567');
  });

  it('refuses anything that is not an Israeli mobile', () => {
    for (const bad of [
      '',
      '050123456',
      '05012345678',
      '0312345678',
      '+97231234567',
      '05o1234567',
      'abc',
      '+1501234567',
    ])
      expect(normalizePhone(bad), bad).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(501234567)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Dana.Levi@Example.TEST ')).toBe('dana.levi@example.test');
  });

  it('refuses malformed addresses and over-long ones', () => {
    for (const bad of [
      '',
      'dana',
      'dana@',
      '@example.test',
      'dana@example',
      'da na@example.test',
      'dana@@example.test',
    ])
      expect(normalizeEmail(bad), bad).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@example.test`)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeTarget', () => {
  it('reads an e-mail when there is an @, else a phone', () => {
    expect(normalizeTarget('Dana@Example.test')).toEqual({ channel: 'email', target: 'dana@example.test' });
    expect(normalizeTarget('+972 50 123 4567')).toEqual({ channel: 'sms', target: '0501234567' });
    expect(normalizeTarget('nonsense')).toBeNull();
  });
});
