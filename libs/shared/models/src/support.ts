/**
 * Support requests (Phase 5d, spec §7, SRV-02, SRV-03, SRV-05): returns and exchanges, damaged products and the
 * contact form. Endpoints under /api/support/ (storefront origin only, throttled per IP and, for order requests, per
 * order number, with a hidden honeypot field `website`). Every accepted request answers 202 `SupportTicketCreated`.
 */

export const SUPPORT_TICKET_TYPES = ['return', 'exchange', 'damaged', 'contact', 'delivery_change'] as const;
export type SupportTicketType = (typeof SUPPORT_TICKET_TYPES)[number];

/** Hebrew name of each ticket type (e-mail alert, admin inbox). */
export const SUPPORT_TICKET_TYPE_LABELS_HE: Record<SupportTicketType, string> = {
  return: 'החזרה',
  exchange: 'החלפה',
  damaged: 'מוצר פגום',
  contact: 'פנייה כללית',
  delivery_change: 'בקשה לשינוי מועד אספקה',
};

/** A ticket starts `new`; staff move it to `in_progress` and `closed` (admin inbox, spec §7.2). */
export const SUPPORT_TICKET_STATUSES = ['new', 'in_progress', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/** The closed list of return / exchange reasons (spec §7.1). */
export const RETURN_REASONS = ['changed_mind', 'not_as_described', 'wrong_item', 'size', 'other'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS_HE: Record<ReturnReason, string> = {
  changed_mind: 'התחרטתי',
  not_as_described: 'לא תואם לתיאור',
  wrong_item: 'התקבל פריט שגוי',
  size: 'המידה לא מתאימה',
  other: 'אחר',
};

/** Length limits (characters, after trimming) and upload limits of the support forms. */
export const SUPPORT_LIMITS = {
  noteMax: 1000,
  descriptionMin: 10,
  descriptionMax: 2000,
  subjectMin: 2,
  subjectMax: 120,
  messageMin: 10,
  messageMax: 2000,
  itemsMax: 50,
  photosMin: 1,
  photosMax: 5,
  photoMaxBytes: 10 * 1024 * 1024,
  photoTypes: ['image/jpeg', 'image/png', 'image/webp'],
} as const;

/** The order of a request made without a session: its number and the phone it was placed with. */
export interface SupportOrderRef {
  number: string;
  phone: string;
}

export interface SupportItemRequest {
  orderItemId: number;
  quantity: number;
}

/**
 * `POST /api/support/returns`. Signed in: `order` may be null (the lines name the order), and the order must be the
 * customer's. Signed out: `order` is required and its number + phone must match. Only a `delivered` order within the
 * return window (`returnWindowDays` after delivery); quantities up to the ordered ones.
 */
export interface ReturnRequestBody {
  order: SupportOrderRef | null;
  type: 'return' | 'exchange';
  items: SupportItemRequest[];
  reasonCode: ReturnReason;
  note?: string;
  /** Honeypot: hidden in the form, always empty. */
  website?: string;
}

/**
 * `POST /api/support/damaged`, multipart: the fields `order[number]`, `order[phone]` (signed out), `orderItemId`,
 * `description` and `website`, plus 1–5 files `photos` (JPEG, PNG or WebP by content, up to 10 MB each). Only a
 * `delivered` order, no day limit.
 */
export interface DamagedRequestFields {
  order: SupportOrderRef | null;
  orderItemId: number;
  description: string;
  website?: string;
}

/** `POST /api/support/contact`. */
export interface ContactRequestBody {
  fullName: string;
  phone: string;
  email: string;
  subject: string;
  message: string;
  orderNumber?: string;
  website?: string;
}

/** 202 of every support request: the number the customer quotes (from 5001). */
export interface SupportTicketCreated {
  ticketNumber: number;
}

/**
 * Error codes of the support endpoints:
 * - `invalid_field` (400, with `field` and `messageHe`; for lines `items.<i>.orderItemId` / `items.<i>.quantity`);
 * - `not_found` (404): no such order, the phone does not match, or not the signed-in customer's — one answer;
 * - `not_delivered` / `return_window_passed` (409, with `messageHe`);
 * - `too_many_requests` (429, `Retry-After`).
 */
export type SupportErrorCode = 'invalid_field' | 'not_found' | 'not_delivered' | 'return_window_passed';

export const SUPPORT_FIELDS = [
  'order',
  'type',
  'items',
  'reasonCode',
  'note',
  'orderItemId',
  'description',
  'photos',
  'fullName',
  'phone',
  'email',
  'subject',
  'message',
  'orderNumber',
] as const;
export type SupportField = (typeof SUPPORT_FIELDS)[number];

/** The Hebrew message of each invalid field (`messageHe` of a 400); a line's field uses the `items` message. */
export const SUPPORT_FIELD_MESSAGES_HE: Record<SupportField, string> = {
  order: 'יש להזין מספר הזמנה ומספר טלפון',
  type: 'יש לבחור החזרה או החלפה',
  items: 'יש לבחור פריטים וכמויות מתוך ההזמנה',
  reasonCode: 'יש לבחור סיבה מהרשימה',
  note: 'ההערה ארוכה מדי (עד 1000 תווים)',
  orderItemId: 'יש לבחור פריט מתוך ההזמנה',
  description: 'יש לתאר את הנזק (10–2000 תווים)',
  photos: 'יש לצרף 1–5 תמונות מסוג JPEG, PNG או WebP, עד 10MB כל אחת',
  fullName: 'יש למלא שם מלא (2–80 תווים)',
  phone: 'יש להזין מספר טלפון נייד תקין, למשל 050-1234567',
  email: 'יש להזין כתובת דוא״ל תקינה',
  subject: 'יש למלא נושא (2–120 תווים)',
  message: 'יש לכתוב הודעה (10–2000 תווים)',
  orderNumber: 'מספר ההזמנה אינו תקין',
};

export const SUPPORT_NOT_DELIVERED_HE = 'אפשר לשלוח בקשה זו רק להזמנה שסופקה';
export const SUPPORT_RETURN_WINDOW_PASSED_HE = 'חלפה התקופה להחזרה או להחלפה של הזמנה זו';
