import type { FulfillmentMode, OptionAxis, VariantDetail } from '@hg/models';

/** axis code → value code */
export type Selection = Readonly<Record<string, string>>;
export type OptionState = 'available' | 'unavailable';
export interface Resolved {
  variant: VariantDetail;
  /** axis codes whose value differs from what was asked */
  adjusted: string[];
}

const AVAILABILITY_RANK: Record<FulfillmentMode, number> = {
  in_stock: 0,
  pre_order: 1,
  made_to_order: 2,
  out_of_stock: 3,
};

/** Keeps only known axis codes with known value codes. */
export function paramsToSelection(
  params: Readonly<Record<string, string | undefined>>,
  axes: readonly OptionAxis[],
): Selection {
  const out: Record<string, string> = {};
  for (const axis of axes) {
    const value = params[axis.code];
    if (value !== undefined && axis.values.some((v) => v.code === value)) out[axis.code] = value;
  }
  return out;
}

export function selectionToParams(variant: VariantDetail, axes: readonly OptionAxis[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const axis of axes) {
    const value = variant.options[axis.code];
    if (value !== undefined) out[axis.code] = value;
  }
  return out;
}

/** Negative when `a` is the better candidate. Ties keep API order (stable sort). */
function compare(a: VariantDetail, b: VariantDetail, axes: readonly OptionAxis[], wanted: Selection): number {
  const matches = (v: VariantDetail, code: string) => code in wanted && v.options[code] === wanted[code];
  const count = (v: VariantDetail) => axes.filter((x) => matches(v, x.code)).length;
  const byCount = count(b) - count(a);
  if (byCount !== 0) return byCount;
  for (const axis of axes) {
    const am = matches(a, axis.code);
    const bm = matches(b, axis.code);
    if (am !== bm) return am ? -1 : 1;
  }
  const byAvailability = AVAILABILITY_RANK[a.fulfillment] - AVAILABILITY_RANK[b.fulfillment];
  if (byAvailability !== 0) return byAvailability;
  return a.price - b.price;
}

/** Precondition: `candidates` is non-empty (a product always has at least one variant). */
function best(candidates: readonly VariantDetail[], axes: readonly OptionAxis[], wanted: Selection): VariantDetail {
  // Stable sort keeps API order as the last tie-breaker.
  return [...candidates].sort((a, b) => compare(a, b, axes, wanted))[0];
}

function differing(variant: VariantDetail, wanted: Selection, axes: readonly OptionAxis[], skip?: string): string[] {
  return axes
    .filter((x) => x.code !== skip && x.code in wanted && variant.options[x.code] !== wanted[x.code])
    .map((x) => x.code);
}

export function resolveSelection(
  variants: readonly VariantDetail[],
  axes: readonly OptionAxis[],
  wanted: Selection,
): Resolved {
  const variant = best(variants, axes, wanted);
  return { variant, adjusted: differing(variant, wanted, axes) };
}

export function pickOption(
  variants: readonly VariantDetail[],
  axes: readonly OptionAxis[],
  current: VariantDetail,
  axis: string,
  value: string,
): Resolved {
  const wanted: Selection = { ...selectionToParams(current, axes), [axis]: value };
  const candidates = variants.filter((v) => v.options[axis] === value);
  // Defensive: unreachable from a UI built from `axes`; then the picked axis itself may change and is reported.
  const variant = best(candidates.length ? candidates : variants, axes, wanted);
  return { variant, adjusted: differing(variant, wanted, axes) };
}

export function optionStates(
  variants: readonly VariantDetail[],
  axes: readonly OptionAxis[],
  current: VariantDetail,
): Record<string, Record<string, OptionState>> {
  const result: Record<string, Record<string, OptionState>> = {};
  for (const axis of axes) {
    const states: Record<string, OptionState> = {};
    for (const value of axis.values) {
      const ok = variants.some(
        (v) =>
          v.options[axis.code] === value.code &&
          v.fulfillment !== 'out_of_stock' &&
          axes.every((o) => o.code === axis.code || v.options[o.code] === current.options[o.code]),
      );
      states[value.code] = ok ? 'available' : 'unavailable';
    }
    result[axis.code] = states;
  }
  return result;
}

export function adjustmentNotice(
  adjusted: readonly string[],
  axes: readonly OptionAxis[],
  variant: VariantDetail,
): string | null {
  if (!adjusted.length) return null;
  const parts = adjusted.map((code) => {
    const axis = axes.find((a) => a.code === code);
    const label = axis?.values.find((v) => v.code === variant.options[code])?.labelHe ?? '';
    return `${axis?.nameHe ?? code} — ${label}`;
  });
  return 'הצירוף שבחרתם לא זמין, ולכן עדכנו: ' + parts.join(', ');
}
