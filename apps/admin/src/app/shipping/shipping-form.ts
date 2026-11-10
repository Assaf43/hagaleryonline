import type {
  AdminShippingConfig,
  AdminShippingRatesInput,
  AdminShippingSettings,
  AdminShippingZone,
  AdminShippingZoneInput,
  LocalityOption,
} from '@hg/models';

/**
 * The shipping screen's form (spec §4.4): prices are typed in shekels (up to agorot) and sent in agorot;
 * the fields keep the typed text, and these pure functions check it and build the API input.
 */

/** Same limit as the API (₪100,000). */
const MAX_AGOROT = 10_000_000;
const SHEKELS = /^\d+(\.\d{1,2})?$/;
const WHOLE = /^\d+$/;

export const MESSAGES = {
  price: 'מחיר בשקלים, 0 ומעלה (עד שתי ספרות אחרי הנקודה)',
  required: 'חובה למלא',
  pair: 'צריך למלא את שני המחירים, או להשאיר את שניהם ריקים',
  percent: 'מספר שלם בין 0 ל-100',
  floor: 'מספר שלם בין 1 ל-60',
  name: 'חובה לתת שם לאזור',
} as const;

export type FormErrors = Record<string, string>;

export interface RateRow {
  categoryId: number | null;
  nameHe: string;
  delivery: string;
  assembly: string;
}

export type SettingsForm = Record<keyof AdminShippingSettings, string>;

export interface ZoneDraft {
  /** Stable key for the list, also for a zone not saved yet. */
  key: number;
  /** null until saved. */
  id: number | null;
  name: string;
  surcharge: string;
  localities: LocalityOption[];
}

export const toShekelText = (agorot: number | null): string => (agorot === null ? '' : String(agorot / 100));

/** Agorot for a shekel amount; null when empty; undefined when it is not a valid amount. */
export function parseShekels(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!SHEKELS.test(t)) return undefined;
  const agorot = Math.round(Number(t) * 100);
  return agorot <= MAX_AGOROT ? agorot : undefined;
}

function parseWhole(text: string, min: number, max: number): number | undefined {
  const t = text.trim();
  if (!WHOLE.test(t)) return undefined;
  const n = Number(t);
  return n >= min && n <= max ? n : undefined;
}

export function rateRows(config: AdminShippingConfig): RateRow[] {
  return config.rates.map((r) => ({
    categoryId: r.categoryId,
    nameHe: r.categoryNameHe,
    delivery: toShekelText(r.deliveryPrice),
    assembly: toShekelText(r.assemblyPrice),
  }));
}

export function settingsForm(s: AdminShippingSettings): SettingsForm {
  return {
    additionalItemPercent: String(s.additionalItemPercent),
    floorSurcharge: toShekelText(s.floorSurcharge),
    floorSurchargeFrom: String(s.floorSurchargeFrom),
  };
}

export function zoneDraft(zone: AdminShippingZone, key: number): ZoneDraft {
  return { key, id: zone.id, name: zone.name, surcharge: toShekelText(zone.surcharge), localities: zone.localities };
}

/**
 * The price list and settings in agorot, or null with the errors by field ("rates.<row>.delivery",
 * "additionalItemPercent"...). The default row (no category) needs both prices; a category row both or neither.
 */
export function ratesInput(
  rows: RateRow[],
  settings: SettingsForm,
): { input: AdminShippingRatesInput | null; errors: FormErrors } {
  const errors: FormErrors = {};
  const rates = rows.map((row, i) => {
    const delivery = parseShekels(row.delivery);
    const assembly = parseShekels(row.assembly);
    const check = (
      key: 'delivery' | 'assembly',
      value: number | null | undefined,
      other: number | null | undefined,
    ) => {
      if (value === undefined) errors[`rates.${i}.${key}`] = MESSAGES.price;
      else if (value === null && row.categoryId === null) errors[`rates.${i}.${key}`] = MESSAGES.required;
      else if (value === null && other !== null && other !== undefined) errors[`rates.${i}.${key}`] = MESSAGES.pair;
    };
    check('delivery', delivery, assembly);
    check('assembly', assembly, delivery);
    return { categoryId: row.categoryId, deliveryPrice: delivery ?? null, assemblyPrice: assembly ?? null };
  });

  const additionalItemPercent = parseWhole(settings.additionalItemPercent, 0, 100);
  if (additionalItemPercent === undefined) errors['additionalItemPercent'] = MESSAGES.percent;
  const floorSurcharge = parseShekels(settings.floorSurcharge);
  if (floorSurcharge === undefined) errors['floorSurcharge'] = MESSAGES.price;
  else if (floorSurcharge === null) errors['floorSurcharge'] = MESSAGES.required;
  const floorSurchargeFrom = parseWhole(settings.floorSurchargeFrom, 1, 60);
  if (floorSurchargeFrom === undefined) errors['floorSurchargeFrom'] = MESSAGES.floor;

  if (Object.keys(errors).length) return { input: null, errors };
  return {
    input: {
      rates,
      settings: {
        additionalItemPercent: additionalItemPercent!,
        floorSurcharge: floorSurcharge!,
        floorSurchargeFrom: floorSurchargeFrom!,
      },
    },
    errors,
  };
}

export function zoneInput(draft: ZoneDraft): { input: AdminShippingZoneInput | null; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = draft.name.trim();
  if (!name) errors['name'] = MESSAGES.name;
  const surcharge = parseShekels(draft.surcharge);
  if (surcharge === undefined) errors['surcharge'] = MESSAGES.price;
  else if (surcharge === null) errors['surcharge'] = MESSAGES.required;
  if (Object.keys(errors).length) return { input: null, errors };
  return { input: { name, surcharge: surcharge!, localityIds: draft.localities.map((l) => l.id) }, errors };
}
