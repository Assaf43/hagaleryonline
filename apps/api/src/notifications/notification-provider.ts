/** An e-mail ready to send. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The sender address (env EMAIL_FROM); the mock only logs it. */
  from?: string;
}

/** A text message ready to send. */
export interface SmsMessage {
  to: string;
  text: string;
}

/** An e-mail provider (CLAUDE.md §4.2, spec §5.2). Business code talks only to this interface. */
export interface EmailProvider {
  readonly code: string;
  sendEmail(message: EmailMessage): Promise<{ messageId: string }>;
}

/** An SMS provider (CLAUDE.md §4.2, spec §5.2). */
export interface SmsProvider {
  readonly code: string;
  sendSms(message: SmsMessage): Promise<{ messageId: string }>;
}

/** Injection tokens of the active providers, chosen by `EMAIL_PROVIDER` / `SMS_PROVIDER` (both required, no default). */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
export const SMS_PROVIDER = 'SMS_PROVIDER';

export { selectProvider } from '../providers/select-provider.js';
