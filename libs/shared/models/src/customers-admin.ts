/**
 * The admin "לקוחות" area (Phase 7c, spec §4.5, CLB-09): the customers list and one customer's profile
 * (`customers.view`). Orders on the profile are the account's own (decision 77: a guest order is never shown even when
 * its phone or e-mail matches). Nothing secret is returned: no token, hash or IP.
 */
import type { DiscountType } from './promotions.js';
import type { AccountBenefit, AccountBenefitStatus } from './account.js';
import type { MarketingStatus } from './marketing.js';
import type { OrderChannel, OrderStatus } from './orders.js';

/** How the account came to exist: the website sign-up, or a seller's quick account in the store (decision 85). */
export type CustomerOrigin = 'web' | 'store';
export const CUSTOMER_ORIGIN_LABELS_HE: Record<CustomerOrigin, string> = { web: 'אתר', store: 'חנות' };

/** The most customers `GET /api/admin/customers` returns per page. */
export const ADMIN_CUSTOMERS_PAGE_SIZE = 30;
/** The longest search text the list takes. */
export const ADMIN_CUSTOMERS_QUERY_MAX = 100;

/** One row of `GET /api/admin/customers?q=&page=` (newest first). */
export interface CustomerRow {
  id: string;
  fullName: string;
  phone: string;
  /** Null for a store quick account without an e-mail. */
  email: string | null;
  createdVia: CustomerOrigin;
  /** ISO time. */
  createdAt: string;
  /** Orders linked to the account. */
  orderCount: number;
}

export interface CustomerPage {
  items: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerProfileOrder {
  number: number;
  createdAt: string;
  status: OrderStatus;
  /** Agorot. */
  total: number;
  channel: OrderChannel;
}

export interface CustomerProfileFavorite {
  productId: number;
  modelName: string;
  nameHe: string;
  /** ISO time the product was added. */
  addedAt: string;
}

export type ConsentEventAction = 'requested' | 'confirmed' | 'withdrawn' | 'provider_unsubscribed' | 'released';
export type ConsentEventSource = 'signup' | 'checkout' | 'account' | 'store' | 'newsletter';
/** Who did it: the customer, a store seller, or the system (a provider webhook or an e-mail release). */
export type ConsentEventActor = 'customer' | 'seller' | 'system';

export interface CustomerConsentEvent {
  action: ConsentEventAction;
  source: ConsentEventSource | null;
  textVersion: string | null;
  actor: ConsentEventActor;
  /** ISO time. */
  at: string;
}

export const CONSENT_ACTION_LABELS_HE: Record<ConsentEventAction, string> = {
  requested: 'בקשת אישור',
  confirmed: 'אישור דיוור',
  withdrawn: 'ביטול הסכמה',
  provider_unsubscribed: 'הסרה דרך כלי הדיוור',
  released: 'כתובת המייל שוחררה',
};
export const CONSENT_SOURCE_LABELS_HE: Record<ConsentEventSource, string> = {
  signup: 'הרשמה',
  checkout: 'קופה',
  account: 'החשבון',
  store: 'מכירה בחנות',
  newsletter: 'טופס הניוזלטר',
};
export const CONSENT_ACTOR_LABELS_HE: Record<ConsentEventActor, string> = {
  customer: 'הלקוח',
  seller: 'מוכר בחנות',
  system: 'המערכת',
};
export const MARKETING_STATUS_LABELS_HE: Record<MarketingStatus, string> = {
  pending: 'ממתין לאישור',
  subscribed: 'מאשר דיוור',
  unsubscribed: 'לא מאשר דיוור',
};

/** The account's marketing consent. `contact` null: the account's e-mail never had a marketing contact. */
export interface CustomerConsent {
  contact: {
    status: MarketingStatus;
    source: ConsentEventSource;
    consentAt: string | null;
    unsubscribedAt: string | null;
  } | null;
  /** Newest first. */
  history: CustomerConsentEvent[];
}

/** An interest category (top level), from favorites and paid orders. */
export interface CustomerInterest {
  slug: string;
  nameHe: string;
}

/** `GET /api/admin/customers/:id` (no-store). */
export interface CustomerProfile {
  id: string;
  fullName: string;
  phone: string;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  createdVia: CustomerOrigin;
  /** The seller who opened a store quick account; null otherwise. */
  createdBySeller: { id: number; name: string } | null;
  createdAt: string;
  /** Newest first, up to `CUSTOMER_PROFILE_ORDERS_MAX`; `orderCount` is the real count. */
  orders: CustomerProfileOrder[];
  orderCount: number;
  favorites: CustomerProfileFavorite[];
  interests: CustomerInterest[];
  consent: CustomerConsent;
  /** The account's personal codes with their status, newest first. */
  codes: AccountBenefit[];
}

export const CUSTOMER_PROFILE_ORDERS_MAX = 50;

/** One active personal-code template the issue dialog offers (`GET /api/admin/customers/code-templates`, `club.manage`). */
export interface CodeTemplateOption {
  id: number;
  name: string;
  discountType: DiscountType;
  /** Percent 1–100, or agorot for a fixed discount. */
  value: number;
  /** Agorot; 0 = none. */
  minSubtotal: number;
  validityDays: number;
}

export const PERSONAL_CODE_STATUS_LABELS_HE: Record<AccountBenefitStatus, string> = {
  active: 'פעיל',
  used: 'נוצל',
  expired: 'פג תוקף',
};
