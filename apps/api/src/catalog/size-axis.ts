import type { OptionAxis } from '@hg/models';

/** Code of the synthetic size axis; a real attribute with this code wins over it. */
export const SIZE_AXIS = 'size';

interface Size {
  width: number;
  depth: number;
}

/**
 * Size is stored as dimensions on each variant, not as an attribute, so the product page
 * gets a synthetic `size` axis when the variants differ in width or depth (PRD-04).
 * Values are "<width>" — or "<width>x<depth>" for the whole axis when two sizes share a width —
 * sorted by width, then depth. `codes[i]` is the value of `variants[i]`.
 * Returns null when every variant has the same size.
 */
export function sizeAxis(
  variants: { widthCm: number; depthCm: number }[],
): { axis: OptionAxis; codes: string[] } | null {
  const sizes: Size[] = variants.map((v) => ({ width: v.widthCm, depth: v.depthCm }));
  const distinct = [...new Map(sizes.map((s) => [`${s.width}x${s.depth}`, s])).values()].sort(
    (a, b) => a.width - b.width || a.depth - b.depth,
  );
  if (distinct.length < 2) return null;
  const withDepth = new Set(distinct.map((s) => s.width)).size < distinct.length;
  const code = (s: Size) => (withDepth ? `${s.width}x${s.depth}` : `${s.width}`);
  const label = (s: Size) => (withDepth ? `${s.width}×${s.depth} ס״מ` : `${s.width} ס״מ`);
  return {
    axis: {
      code: SIZE_AXIS,
      nameHe: 'מידה',
      values: distinct.map((s) => ({ code: code(s), labelHe: label(s), hex: null })),
    },
    codes: sizes.map(code),
  };
}

/**
 * Puts size after fabric and before chaise side (PRD-04: color, fabric, size, chaise side):
 * right before the first axis whose attribute order is after fabric's, else last.
 * Without a fabric attribute it goes before chaise side, else last.
 */
export function insertSizeAxis(
  axes: OptionAxis[],
  size: OptionAxis,
  order: { fabricOrder: number | undefined; axisOrder: (code: string) => number },
): OptionAxis[] {
  const { fabricOrder, axisOrder } = order;
  const index =
    fabricOrder === undefined
      ? axes.findIndex((a) => a.code === 'chaise-side')
      : axes.findIndex((a) => axisOrder(a.code) > fabricOrder);
  return index === -1 ? [...axes, size] : [...axes.slice(0, index), size, ...axes.slice(index)];
}
