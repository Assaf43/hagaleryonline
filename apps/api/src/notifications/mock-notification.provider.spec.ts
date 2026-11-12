import { MockNotificationProvider } from './mock-notification.provider.js';
import { selectProvider } from '../providers/select-provider.js';
import type { ConfigService } from '@nestjs/config';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('MockNotificationProvider', () => {
  it('refuses NODE_ENV=production', () => {
    expect(() => new MockNotificationProvider(config({ NODE_ENV: 'production' }))).toThrow(/production/);
  });

  it('returns a mock_ message id and sends nothing', async () => {
    const p = new MockNotificationProvider(config({}));
    expect(p.code).toBe('mock');
    const a = await p.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>x</p>', text: 'x' });
    const b = await p.sendSms({ to: '0501234567', text: 'x' });
    expect(a.messageId).toMatch(/^mock_[0-9a-f]+$/);
    expect(b.messageId).toMatch(/^mock_/);
    expect(a.messageId).not.toBe(b.messageId);
  });
});

describe('selectProvider', () => {
  const factories = { mock: () => ({ code: 'mock' }) };

  it('a missing code stops startup and names the variable', () => {
    expect(() => selectProvider('EMAIL_PROVIDER', undefined, factories)).toThrow(/EMAIL_PROVIDER is not set/);
    expect(() => selectProvider('SMS_PROVIDER', '  ', factories)).toThrow(/SMS_PROVIDER is not set/);
  });

  it('an unknown code names the variable and the choices', () => {
    expect(() => selectProvider('EMAIL_PROVIDER', 'nope', factories)).toThrow(/Unknown EMAIL_PROVIDER "nope".*mock/);
  });

  it('builds only the selected adapter', () => {
    expect(selectProvider('SMS_PROVIDER', ' mock ', factories)).toEqual({ code: 'mock' });
  });
});
