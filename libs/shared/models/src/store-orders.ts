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
