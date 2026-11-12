/** Notifications (Phase 5b, spec §5.2): the dev viewer of the messages the `mock` provider "sent". */

export type NotificationChannel = 'email' | 'sms';

/** One row of GET /api/admin/dev/messages (permission orders.manage; 404 unless both providers are `mock`). */
export interface AdminSentMessage {
  id: string;
  channel: NotificationChannel;
  recipientMasked: string;
  template: string;
  provider: string;
  status: 'sent' | 'failed';
  orderNumber: number | null;
  createdAt: string;
  /** E-mail subject; null for an SMS. */
  subject: string | null;
  /** The rendered message: HTML for an e-mail, plain text for an SMS. */
  body: string | null;
}
