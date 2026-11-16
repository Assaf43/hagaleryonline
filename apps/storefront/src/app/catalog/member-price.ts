import { Injectable, computed, inject } from '@angular/core';
import { CustomerStore } from '../account/customer.store';

/** Copy of the club member price (CLB-03, decision 91), kept in one place. */
export const MEMBER_PRICE_LABEL_HE = 'מחיר מועדון';
export const MEMBER_GUEST_LINE_HE = 'חברי מועדון:';
export const MEMBER_JOIN_PREFIX_HE = 'חברי מועדון משלמים';
export const MEMBER_JOIN_LINK_HE = 'התחברות או הצטרפות';
/** Cart hint for a guest: "חברי מועדון היו חוסכים 150 ₪. התחברות או הצטרפות". */
export const MEMBER_SAVINGS_HINT_HE = 'חברי מועדון היו חוסכים';
/** Screen-reader text before a struck-through regular price. */
export const REGULAR_PRICE_SR_HE = 'מחיר רגיל ';

export type MemberLine = { kind: 'guest'; price: number } | { kind: 'member' };

export interface MemberPriceView {
  /** The price shown large: the member price for a member, otherwise the current price. */
  main: number;
  /** The price shown struck through (the old sale price, or for a member the regular/sale price), or null. */
  struck: number | null;
  /** The small line: a guest's "חברי מועדון: <price>" or a member's label; null when there is none. */
  memberLine: MemberLine | null;
  /** The product page's guest box links to sign-in / sign-up. */
  joinLink: boolean;
}

/**
 * What to show for a price (option A, spec §2.2/§4.2). `isMember`: `null` while the browser does not know the viewer
 * yet (and always in the server render) — the regular price only, so nothing personal is in the HTML; `false` a guest;
 * `true` a signed-in customer. Every number is the server's (decision 68); a member price that is not lower than the
 * current price is ignored.
 */
export function memberPriceView(
  price: number,
  compareAt: number | null,
  memberPrice: number | null,
  isMember: boolean | null,
): MemberPriceView {
  const regular: MemberPriceView = {
    main: price,
    struck: compareAt !== null && compareAt > price ? compareAt : null,
    memberLine: null,
    joinLink: false,
  };
  if (memberPrice === null || memberPrice >= price || isMember === null) return regular;
  if (isMember) return { main: memberPrice, struck: price, memberLine: { kind: 'member' }, joinLink: false };
  return { ...regular, memberLine: { kind: 'guest', price: memberPrice }, joinLink: true };
}

/** Who is looking, as `memberPriceView` wants it: decided in the browser from `CustomerStore` only. */
@Injectable({ providedIn: 'root' })
export class Viewer {
  private readonly customer = inject(CustomerStore);
  readonly isMember = computed<boolean | null>(() => (this.customer.ready() ? this.customer.me() !== null : null));
}
