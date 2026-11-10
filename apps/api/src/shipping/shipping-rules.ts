import type { ShippingOption, ShippingQuoteLine } from '@hg/models';

/** Shipping price rules (spec §4.1, SHP-01–03). Pure; every amount is integer agorot. */

/** The delivery and assembly price of one unit (one piece of furniture) to ship. */
export interface ShippingUnit {
  deliveryPrice: number;
  assemblyPrice: number;
}

/** A rate row of the price list; `categoryId` null is the default row. */
export interface ShippingRateRow {
  categoryId: number | null;
  deliveryPrice: number;
  assemblyPrice: number;
}

export interface ShippingPriceSettings {
  /** Percent of its delivery price each unit after the most expensive one pays. */
  additionalItemPercent: number;
  /** Per floor, at and above `floorSurchargeFrom`, without an elevator (full service only). */
  floorSurcharge: number;
  floorSurchargeFrom: number;
}

export interface ShippingContext {
  floor: number;
  hasElevator: boolean;
  /** The remote-zone surcharge of the locality, 0 outside any zone; added once to both methods. */
  zoneSurcharge: number;
  zoneName?: string;
}

export const LABEL_DELIVERY = 'הובלה';
export const LABEL_DISCOUNT = 'הנחה על פריטים נוספים';
export const LABEL_ASSEMBLY = 'הרכבה';
export const LABEL_FLOOR = 'תוספת קומה ללא מעלית';
export const LABEL_ZONE = 'תוספת אזור';
/** "תוספת אזור: אילת והערבה"; without a zone name just "תוספת אזור". */
export const zoneLabel = (zone?: string) => (zone?.trim() ? `${LABEL_ZONE}: ${zone.trim()}` : LABEL_ZONE);

/**
 * One unit per piece: quantity N of a variant is N units. Each uses its top-level category's rate, else the
 * default row, else 0 (no price list yet).
 */
export function shippingUnits(
  items: { topCategoryId: number; quantity: number }[],
  rates: ShippingRateRow[],
): ShippingUnit[] {
  const byCategory = new Map(rates.map((r) => [r.categoryId, r]));
  const fallback = byCategory.get(null);
  return items.flatMap(({ topCategoryId, quantity }) => {
    const rate = byCategory.get(topCategoryId) ?? fallback;
    const unit = { deliveryPrice: rate?.deliveryPrice ?? 0, assemblyPrice: rate?.assemblyPrice ?? 0 };
    return Array.from({ length: Math.max(0, quantity) }, () => ({ ...unit }));
  });
}

/** Both methods, curbside first. Lines with nothing to charge are left out, except the delivery line. */
export function quoteShipping(
  units: ShippingUnit[],
  settings: ShippingPriceSettings,
  ctx: ShippingContext,
): ShippingOption[] {
  const delivery = deliveryLines(units, settings);
  const zone: ShippingQuoteLine[] =
    ctx.zoneSurcharge > 0 ? [{ labelHe: zoneLabel(ctx.zoneName), amount: ctx.zoneSurcharge }] : [];

  const assembly = units.reduce((sum, u) => sum + u.assemblyPrice, 0);
  const floors =
    !ctx.hasElevator && ctx.floor >= settings.floorSurchargeFrom ? ctx.floor - settings.floorSurchargeFrom + 1 : 0;
  const floorAmount = floors * settings.floorSurcharge;
  const fullService: ShippingQuoteLine[] = [
    ...delivery,
    ...(assembly > 0 ? [{ labelHe: LABEL_ASSEMBLY, amount: assembly }] : []),
    ...(floorAmount > 0 ? [{ labelHe: LABEL_FLOOR, amount: floorAmount }] : []),
    ...zone,
  ];

  return [option('curbside', [...delivery, ...zone]), option('full_service', fullService)];
}

/** Lowest delivery price for the cart (CRT-05): curbside without zone or floor surcharges. */
export function shippingFrom(units: ShippingUnit[], settings: ShippingPriceSettings): number {
  return deliveryLines(units, settings).reduce((sum, l) => sum + l.amount, 0);
}

/** Full delivery price of every unit, then the multi-item discount (every unit but the most expensive). */
function deliveryLines(units: ShippingUnit[], settings: ShippingPriceSettings): ShippingQuoteLine[] {
  const prices = units.map((u) => u.deliveryPrice).sort((a, b) => b - a);
  const full = prices.reduce((sum, p) => sum + p, 0);
  const discount = prices
    .slice(1)
    .reduce((sum, p) => sum + (p - Math.round((p * settings.additionalItemPercent) / 100)), 0);
  const lines: ShippingQuoteLine[] = [{ labelHe: LABEL_DELIVERY, amount: full }];
  if (discount > 0) lines.push({ labelHe: LABEL_DISCOUNT, amount: -discount });
  return lines;
}

function option(method: ShippingOption['method'], lines: ShippingQuoteLine[]): ShippingOption {
  return { method, total: lines.reduce((sum, l) => sum + l.amount, 0), lines };
}
