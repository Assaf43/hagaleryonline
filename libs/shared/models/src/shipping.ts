/** One locality in the checkout address autocomplete (GET /api/localities?q=). */
export interface LocalityOption {
  id: number;
  nameHe: string;
}

/**
 * Shipping (Phase 4b, spec §4.1, §4.3, SHP-01–03). Money is in agorot (integer, VAT included).
 * `curbside` is delivery to the unloading point only; `full_service` adds carrying, assembly and the floor surcharge.
 */
export type ShippingMethod = 'curbside' | 'full_service';

/** POST /api/shipping/quote — the cart comes from the cookie. */
export interface ShippingQuoteRequest {
  /** CBS locality code (GET /api/localities). */
  localityId: number;
  /** 0 = ground floor, at most 60. */
  floor: number;
  hasElevator: boolean;
}

/** One line of the breakdown; a discount is negative. */
export interface ShippingQuoteLine {
  labelHe: string;
  amount: number;
}

export interface ShippingOption {
  method: ShippingMethod;
  /** Sum of the lines. */
  total: number;
  lines: ShippingQuoteLine[];
}

export interface ShippingQuote {
  methods: ShippingOption[];
}

/** Error codes of the shipping API (`{ statusCode, code }`). */
export type ShippingErrorCode = 'invalid_input' | 'unknown_locality' | 'empty_cart';
