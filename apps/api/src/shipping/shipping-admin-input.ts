import type { AdminShippingRatesInput, AdminShippingSettings, AdminShippingZoneInput } from '@hg/models';
import { invalid } from '../catalog-admin/catalog-errors.js';

/** Highest amount any price-list field accepts (₪100,000 in agorot): keeps sums far from the Int limit. */
export const MAX_AMOUNT = 10_000_000;
/** Highest floor a quote accepts; the floor surcharge cannot start above it. */
export const MAX_FLOOR = 60;
const MAX_NAME = 100;
const MAX_ZONE_LOCALITIES = 2_000;

type Body = Record<string, unknown>;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function int(value: unknown, field: string, min: number, max: number): number {
  if (!isInt(value, min, max)) throw invalid(field);
  return value;
}

/**
 * PUT /api/admin/shipping/rates (spec §4.4): the whole price list and the settings. Amounts are integer agorot
 * ≥ 0; the default row is required with both prices; a category row has both prices or neither (no rate of its
 * own). Whether a category exists and is top-level is checked by the service.
 */
export function parseRatesInput(body: unknown): AdminShippingRatesInput {
  const { rates, settings } = (body ?? {}) as Body;
  if (!Array.isArray(rates)) throw invalid('rates');
  const seen = new Set<number | null>();
  const parsed = rates.map((row: unknown, i) => {
    const r = (row ?? {}) as Body;
    const categoryId = r.categoryId === null ? null : int(r.categoryId, `rates.${i}.categoryId`, 1, 2 ** 31 - 1);
    if (seen.has(categoryId)) throw invalid(`rates.${i}.categoryId`);
    seen.add(categoryId);
    const price = (key: 'deliveryPrice' | 'assemblyPrice') =>
      r[key] === null && categoryId !== null ? null : int(r[key], `rates.${i}.${key}`, 0, MAX_AMOUNT);
    const deliveryPrice = price('deliveryPrice');
    const assemblyPrice = price('assemblyPrice');
    if ((deliveryPrice === null) !== (assemblyPrice === null))
      throw invalid(`rates.${i}.${deliveryPrice === null ? 'deliveryPrice' : 'assemblyPrice'}`);
    return { categoryId, deliveryPrice, assemblyPrice };
  });
  if (!seen.has(null)) throw invalid('rates');
  return { rates: parsed, settings: parseSettings(settings) };
}

function parseSettings(body: unknown): AdminShippingSettings {
  const s = (body ?? {}) as Body;
  return {
    additionalItemPercent: int(s.additionalItemPercent, 'additionalItemPercent', 0, 100),
    floorSurcharge: int(s.floorSurcharge, 'floorSurcharge', 0, MAX_AMOUNT),
    floorSurchargeFrom: int(s.floorSurchargeFrom, 'floorSurchargeFrom', 1, MAX_FLOOR),
  };
}

/** POST/PUT /api/admin/shipping/zones: a name, a surcharge in agorot ≥ 0 and distinct CBS locality codes. */
export function parseZoneInput(body: unknown): AdminShippingZoneInput {
  const { name, surcharge, localityIds } = (body ?? {}) as Body;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_NAME) throw invalid('name');
  if (
    !Array.isArray(localityIds) ||
    localityIds.length > MAX_ZONE_LOCALITIES ||
    !localityIds.every((id) => isInt(id, 1, 2 ** 31 - 1)) ||
    new Set(localityIds).size !== localityIds.length
  )
    throw invalid('localityIds');
  return { name: trimmed, surcharge: int(surcharge, 'surcharge', 0, MAX_AMOUNT), localityIds: localityIds as number[] };
}
