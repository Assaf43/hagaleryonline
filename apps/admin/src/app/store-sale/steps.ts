import type { CheckoutAddress, ShippingMethod, StoreCartView } from '@hg/models';
import { errorCode } from './store-errors';

export type SaleStep = 'products' | 'customer' | 'delivery' | 'summary' | 'status';

export const STEP_LABELS: Record<SaleStep, string> = {
  products: 'מוצרים',
  customer: 'לקוח',
  delivery: 'משלוח',
  summary: 'סיכום',
  status: 'תשלום',
};

export const STEPS: SaleStep[] = ['products', 'customer', 'delivery', 'summary', 'status'];

/** The seller's delivery choice: what the order request needs, and what the total on screen includes. */
export interface DeliveryChoice {
  address: CheckoutAddress;
  localityName: string;
  method: ShippingMethod;
  /** Agorot: the chosen method's shipping total. */
  shippingTotal: number;
  saveAddress: boolean;
}

export interface SaleState {
  cart: StoreCartView | null;
  delivery: DeliveryChoice | null;
  /** The order of this sale, once it was placed. */
  orderNumber: number | null;
  /** An order was placed for this sale: only the status step is open until a new sale starts. */
  locked: boolean;
}

const hasLines = (cart: StoreCartView | null) => !!cart && cart.lines.some((l) => l.available);

/** Whether a step may be opened: each one needs what the earlier ones produce (spec §4.1). */
export function canEnter(step: SaleStep, state: SaleState): boolean {
  if (state.locked && step !== 'status') return false;
  switch (step) {
    case 'products':
      return true;
    case 'customer':
      return hasLines(state.cart);
    case 'delivery':
      return hasLines(state.cart) && !!state.cart?.customer;
    case 'summary':
      return hasLines(state.cart) && !!state.cart?.customer && !!state.delivery;
    case 'status':
      return state.orderNumber !== null;
  }
}

/** Where an API error sends the seller: a lapsed customer confirmation goes back to the customer step. */
export function stepAfterError(error: unknown): SaleStep | null {
  return errorCode(error) === 'customer_not_confirmed' ? 'customer' : null;
}

/** The code the customer reads out: digits only, six at most. */
export function sanitizeCode(text: string): string {
  return text.replace(/\D/g, '').slice(0, 6);
}

export const isCompleteCode = (code: string) => /^\d{6}$/.test(code);
