/** Seller-assisted store orders (Phase 6, ADM-18, spec §4.4–§4.6). */

/** The one physical store: shown only in the admin (decision 43). */
export interface StoreInfo {
  id: number;
  nameHe: string;
  address: string;
  hoursHe: string;
  phone: string;
}
