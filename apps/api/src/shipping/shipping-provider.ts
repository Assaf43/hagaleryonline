import type { ShippingMethod, ShippingQuote, ShippingQuoteRequest } from '@hg/models';

/** One cart line to ship: N units of a variant, with the top-level category its rate comes from. */
export interface ShipmentItem {
  variantId: number;
  /** Top-level category of the product (the price list is per top-level category). */
  topCategoryId: number;
  quantity: number;
}

/** What a provider quotes: the customer's address details plus the available cart lines. */
export interface ProviderQuoteRequest extends ShippingQuoteRequest {
  items: ShipmentItem[];
}

/** The order to ship (Phase 4c fills in more as orders exist). */
export interface ShipmentOrder {
  orderId: string;
  method: ShippingMethod;
  localityId: number;
  items: ShipmentItem[];
}

/**
 * A delivery provider (architecture.md §6, spec §4.3). Every carrier is its own adapter; business code only
 * talks to this interface. `code` is stored with each shipment.
 */
export interface ShippingProvider {
  readonly code: string;
  quote(req: ProviderQuoteRequest): Promise<ShippingQuote>;
  createShipment(order: ShipmentOrder): Promise<{ shipmentId: string }>;
}

/** Injection token of the active provider, chosen by the `SHIPPING_PROVIDER` env variable (default `manual`). */
export const SHIPPING_PROVIDER = 'SHIPPING_PROVIDER';

/** The adapter named by `code` (empty → `manual`); an unknown code fails at startup. */
export function selectShippingProvider(code: string | undefined, adapters: ShippingProvider[]): ShippingProvider {
  const wanted = code?.trim() || 'manual';
  const adapter = adapters.find((a) => a.code === wanted);
  if (!adapter)
    throw new Error(
      `Unknown SHIPPING_PROVIDER "${wanted}". Expected one of: ${adapters.map((a) => a.code).join(', ')}.`,
    );
  return adapter;
}
