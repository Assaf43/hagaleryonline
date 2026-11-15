/** Seller-assisted store orders (Phase 6, ADM-18, spec §4.4–§4.6). */
import type { CartView } from './cart.js';

/** The one physical store: shown only in the admin (decision 43). */
export interface StoreInfo {
  id: number;
  nameHe: string;
  address: string;
  hoursHe: string;
  phone: string;
}

/** The customer a seller attached to the store cart (spec §4.2). `isNew`: created at the store, no paid order yet. */
export interface StoreCustomer {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  isNew: boolean;
}

/** The store cart: the website cart's view plus the attached customer. */
export type StoreCartView = CartView & { customer: StoreCustomer | null };

/**
 * `POST /api/admin/store-cart/customer/lookup` `{ phone }` (spec §4.1 step 2): whether the phone has an account, and
 * what the seller may show of it. `maskedEmail` is null for an account without an e-mail; a code goes to the e-mail
 * only when `emailVerified` (decision 85).
 */
export type StoreCustomerLookup =
  { exists: false } | { exists: true; fullName: string; maskedEmail: string | null; emailVerified: boolean };

/** Where the confirmation code goes: the phone, or the account's verified e-mail. A new phone takes `sms` only. */
export type StoreCodeChannel = 'sms' | 'email';

/**
 * The details the seller types for a new phone (a quick account: `fullName` and `email`, both required), or only
 * `email` for an existing account that has none (saved unverified).
 */
export interface StoreNewCustomer {
  fullName?: string;
  email: string;
}

/** `POST /api/admin/store-cart/customer/code` → 204. */
export interface StoreCodeRequest {
  phone: string;
  channel: StoreCodeChannel;
  newCustomer?: StoreNewCustomer;
}

/** `POST /api/admin/store-cart/customer/verify` → `StoreCartView` with the confirmed customer. */
export interface StoreVerifyRequest extends StoreCodeRequest {
  code: string;
}
