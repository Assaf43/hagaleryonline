/**
 * Outbox jobs (spec §5.1, decision 83): side effects of order changes (e-mail, SMS, invoices, refunds) written in
 * the transaction of the change and run by the API's worker with retries.
 */

export const OUTBOX_JOB_TYPES = [
  'email.order_paid',
  'email.status',
  'email.cancelled',
  'email.refund',
  'sms.delivery_slot',
  'invoice.issue',
  'invoice.credit_note',
  'refund.late_payment',
] as const;

export type OutboxJobType = (typeof OUTBOX_JOB_TYPES)[number];

/** Hebrew name of each job type, for the admin "משימות שנכשלו" page. */
export const OUTBOX_JOB_LABELS_HE: Record<OutboxJobType, string> = {
  'email.order_paid': 'אישור הזמנה במייל',
  'email.status': 'עדכון סטטוס במייל',
  'email.cancelled': 'הודעת ביטול במייל',
  'email.refund': 'הודעת החזר במייל',
  'sms.delivery_slot': 'SMS תיאום אספקה',
  'invoice.issue': 'הפקת חשבונית',
  'invoice.credit_note': 'הפקת חשבונית זיכוי',
  'refund.late_payment': 'החזר תשלום מאוחר',
};

/** One row of GET /api/admin/jobs/failed (permission orders.manage). */
export interface AdminFailedJob {
  id: string;
  type: OutboxJobType;
  /** The order the job belongs to, or null. */
  orderNumber: number | null;
  attempts: number;
  lastError: string | null;
  /** ISO time of the last change (when it failed). */
  updatedAt: string;
}
