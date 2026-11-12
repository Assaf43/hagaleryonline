import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { EmailMessage, EmailProvider, SmsMessage, SmsProvider } from './notification-provider.js';

export const MOCK_CODE = 'mock';

/**
 * `mock` adapter (development and tests, spec §5.2): sends nothing anywhere. `NotificationsService` logs every
 * message with its full body while this provider is active (the dev viewer). Refuses to load in production.
 */
export class MockNotificationProvider implements EmailProvider, SmsProvider {
  readonly code = MOCK_CODE;

  constructor(config: ConfigService) {
    if (config.get<string>('NODE_ENV') === 'production')
      throw new Error('EMAIL_PROVIDER / SMS_PROVIDER = mock cannot run in production: choose a real provider.');
  }

  sendEmail(_message: EmailMessage): Promise<{ messageId: string }> {
    return Promise.resolve({ messageId: messageId() });
  }

  sendSms(_message: SmsMessage): Promise<{ messageId: string }> {
    return Promise.resolve({ messageId: messageId() });
  }
}

const messageId = () => `mock_${randomBytes(8).toString('hex')}`;
