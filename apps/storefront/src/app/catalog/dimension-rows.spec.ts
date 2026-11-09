import { describe, expect, it } from 'vitest';
import type { Dimensions } from '@hg/models';
import { dimensionRows } from './dimension-rows';

const base: Dimensions = {
  widthCm: 280,
  depthCm: 100,
  heightCm: 80,
  weightKg: null,
  seatHeightCm: null,
  seatDepthCm: null,
  chaiseWidthCm: null,
  chaiseDepthCm: null,
};

describe('dimensionRows', () => {
  it('dimensionRows order, units and skipped nulls', () => {
    expect(dimensionRows(base)).toEqual([
      { labelHe: 'רוחב', value: '280 ס״מ' },
      { labelHe: 'עומק', value: '100 ס״מ' },
      { labelHe: 'גובה', value: '80 ס״מ' },
    ]);
    const all = dimensionRows({
      ...base,
      weightKg: 65,
      seatHeightCm: 45,
      seatDepthCm: 60,
      chaiseWidthCm: 90,
      chaiseDepthCm: 160,
    });
    expect(all.map((r) => r.labelHe)).toEqual([
      'רוחב',
      'עומק',
      'גובה',
      'גובה ישיבה',
      'עומק ישיבה',
      'רוחב שזלונג',
      'עומק שזלונג',
      'משקל',
    ]);
    expect(all.at(-1)?.value).toBe('65 ק״ג');
  });
});
