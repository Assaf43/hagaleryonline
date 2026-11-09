import type { OptionAxis } from '@hg/models';
import { insertSizeAxis, sizeAxis } from './size-axis.js';

const sizes = (...pairs: [number, number][]) => pairs.map(([widthCm, depthCm]) => ({ widthCm, depthCm }));

describe('sizeAxis (PRD-04)', () => {
  it('uses the width when every size has its own width, sorted by width', () => {
    const result = sizeAxis(sizes([300, 95], [260, 95], [340, 95], [260, 95]))!;
    expect(result.axis).toEqual({
      code: 'size',
      nameHe: 'מידה',
      values: [
        { code: '260', labelHe: '260 ס״מ', hex: null },
        { code: '300', labelHe: '300 ס״מ', hex: null },
        { code: '340', labelHe: '340 ס״מ', hex: null },
      ],
    });
    expect(result.codes).toEqual(['300', '260', '340', '260']);
  });

  it('uses width×depth for the whole axis when two sizes share a width', () => {
    const result = sizeAxis(sizes([200, 300], [160, 230], [200, 290]))!;
    expect(result.axis.values).toEqual([
      { code: '160x230', labelHe: '160×230 ס״מ', hex: null },
      { code: '200x290', labelHe: '200×290 ס״מ', hex: null },
      { code: '200x300', labelHe: '200×300 ס״מ', hex: null },
    ]);
    expect(result.codes).toEqual(['200x300', '160x230', '200x290']);
  });

  it('returns null when every variant has the same size', () => {
    expect(sizeAxis(sizes([220, 92], [220, 92]))).toBeNull();
    expect(sizeAxis(sizes([220, 92]))).toBeNull();
  });
});

describe('insertSizeAxis', () => {
  const axis = (code: string): OptionAxis => ({ code, nameHe: code, values: [] });
  const ORDER: Record<string, number> = { color: 1, fabric: 2, 'chaise-side': 3, softness: 4 };
  const codes = (axes: OptionAxis[], fabricOrder: number | undefined = ORDER['fabric']) =>
    insertSizeAxis(axes, axis('size'), { fabricOrder, axisOrder: (c) => ORDER[c]! }).map((a) => a.code);

  it('goes after fabric and before chaise side', () => {
    expect(codes([axis('color'), axis('fabric'), axis('chaise-side')])).toEqual([
      'color',
      'fabric',
      'size',
      'chaise-side',
    ]);
    expect(codes([axis('color'), axis('chaise-side')])).toEqual(['color', 'size', 'chaise-side']);
  });

  it('goes last when no axis comes after fabric', () => {
    expect(codes([axis('color'), axis('fabric')])).toEqual(['color', 'fabric', 'size']);
    expect(codes([])).toEqual(['size']);
  });

  it('without a fabric attribute, goes before chaise side or last', () => {
    const noFabric = (axes: OptionAxis[]) =>
      insertSizeAxis(axes, axis('size'), { fabricOrder: undefined, axisOrder: (c) => ORDER[c]! }).map((a) => a.code);
    expect(noFabric([axis('color'), axis('chaise-side')])).toEqual(['color', 'size', 'chaise-side']);
    expect(noFabric([axis('color'), axis('softness')])).toEqual(['color', 'softness', 'size']);
  });
});
