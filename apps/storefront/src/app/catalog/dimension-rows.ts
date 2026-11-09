import type { Dimensions } from '@hg/models';

export interface DimensionRow {
  labelHe: string;
  value: string;
}

const CM: [keyof Dimensions, string][] = [
  ['widthCm', 'רוחב'],
  ['depthCm', 'עומק'],
  ['heightCm', 'גובה'],
  ['seatHeightCm', 'גובה ישיבה'],
  ['seatDepthCm', 'עומק ישיבה'],
  ['chaiseWidthCm', 'רוחב שזלונג'],
  ['chaiseDepthCm', 'עומק שזלונג'],
];

/** Rows of the dimensions table (PRD-06): fixed order, units in the value, empty fields skipped. */
export function dimensionRows(d: Dimensions): DimensionRow[] {
  const rows: DimensionRow[] = [];
  for (const [key, labelHe] of CM) {
    const n = d[key];
    if (n != null) rows.push({ labelHe, value: `${n} ס״מ` });
  }
  if (d.weightKg != null) rows.push({ labelHe: 'משקל', value: `${d.weightKg} ק״ג` });
  return rows;
}
