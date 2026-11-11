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

/** The methods' names, as the customer and the staff both see them (spec §4.1): one wording on both sides. */
export const SHIPPING_METHOD_LABELS_HE: Record<ShippingMethod, string> = {
  curbside: 'עד נקודת הפריקה',
  full_service: 'כולל סבלות והרכבה',
};

/** Highest floor a quote or an order accepts (0 = ground floor); the floor surcharge cannot start above it. */
export const MAX_FLOOR = 60;

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
export type ShippingErrorCode = 'invalid_input' | 'unknown_locality' | 'empty_cart' | 'shipping_unavailable';

// ---------- Admin (spec §4.4, ADM-07) ----------

/**
 * One row of the price list. `categoryId` null is the default row, used by every top-level category without
 * a rate of its own. A category row with null prices has no rate and uses the default row.
 */
export interface AdminShippingRate {
  categoryId: number | null;
  categoryNameHe: string;
  deliveryPrice: number | null;
  assemblyPrice: number | null;
}

export interface AdminShippingSettings {
  /** 0–100: percent of its delivery price every unit after the most expensive one pays. */
  additionalItemPercent: number;
  /** Per floor without an elevator (full service only). */
  floorSurcharge: number;
  /** 1–60: the first floor that pays the floor surcharge. */
  floorSurchargeFrom: number;
}

export interface AdminShippingZone {
  id: number;
  name: string;
  surcharge: number;
  localities: LocalityOption[];
}

/** GET /api/admin/shipping: the default row first, then one row per top-level category in tree order. */
export interface AdminShippingConfig {
  rates: AdminShippingRate[];
  /** False until the default row is saved for the first time (it then reads as 0 / 0). */
  defaultRateSet: boolean;
  settings: AdminShippingSettings;
  zones: AdminShippingZone[];
}

/**
 * PUT /api/admin/shipping/rates: the whole price list and the settings, saved together. The default row
 * (`categoryId` null) is required and needs both prices; a category row with null prices removes its rate.
 */
export interface AdminShippingRatesInput {
  rates: { categoryId: number | null; deliveryPrice: number | null; assemblyPrice: number | null }[];
  settings: AdminShippingSettings;
}

/** POST /api/admin/shipping/zones and PUT /api/admin/shipping/zones/:id. */
export interface AdminShippingZoneInput {
  name: string;
  surcharge: number;
  localityIds: number[];
}

/**
 * 409 of the zone endpoints: a locality is in at most one zone. The body names the locality and the zone
 * it already belongs to: `{ statusCode, code: 'locality_taken', localityNameHe, zoneName }`.
 */
export type ShippingAdminErrorCode = 'locality_taken';
