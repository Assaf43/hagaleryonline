import type { AdminVariant } from '@hg/models';
import { descriptionText, sanitizeDescription } from '../catalog/description-html.js';
import { changedFields, parseAttributeValueInput, parseProductInput, parseSynonymTerms } from './catalog-input.js';
import { activationProblems } from './products-admin.service.js';

const variant = (extra: Partial<AdminVariant> = {}) => ({
  sku: 'alba-300-bg',
  price: 499_000,
  compareAtPrice: null,
  stock: 2,
  fulfillment: 'in_stock',
  leadTimeDays: 14,
  productionDays: null,
  expectedAt: null,
  active: true,
  widthCm: 300,
  depthCm: 95.04,
  heightCm: 85,
  weightKg: null,
  seatHeightCm: 45,
  seatDepthCm: null,
  chaiseWidthCm: null,
  chaiseDepthCm: null,
  options: { color: 'beige' },
  ...extra,
});

const product = (extra: Record<string, unknown> = {}) => ({
  slug: 'alba-corner-sofa',
  modelName: ' alba ',
  nameHe: 'ספה פינתית אלבה',
  descriptionHe: '<p>ספה <b>רכה</b></p>',
  categoryId: 3,
  roomIds: [1, 1],
  attributes: { style: ['modern'] },
  countryOfOrigin: null,
  warrantyMonths: 12,
  careHe: null,
  requiresAssembly: false,
  active: false,
  sortOrder: 0,
  variants: [variant()],
  ...extra,
});

const fieldOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse(): { field: string } }).getResponse().field;
  }
  return null;
};

describe('parseProductInput', () => {
  it('normalizes the model name, SKUs, rooms and dimensions', () => {
    const p = parseProductInput(product());
    expect(p.modelName).toBe('ALBA');
    expect(p.roomIds).toEqual([1]);
    expect(p.variants[0].sku).toBe('ALBA-300-BG');
    expect(p.variants[0].depthCm).toBe(95);
    expect(p.descriptionHe).toBe('<p>ספה <strong>רכה</strong></p>');
  });

  it('points at the field that is wrong', () => {
    expect(fieldOf(() => parseProductInput(product({ slug: 'Alba Sofa' })))).toBe('slug');
    expect(fieldOf(() => parseProductInput(product({ modelName: 'אלבה' })))).toBe('modelName');
    expect(fieldOf(() => parseProductInput(product({ variants: [variant(), variant({ price: 0 })] })))).toBe(
      'variants.1.price',
    );
    expect(fieldOf(() => parseProductInput(product({ variants: [variant({ widthCm: -1 })] })))).toBe(
      'variants.0.widthCm',
    );
    expect(fieldOf(() => parseProductInput(product({ variants: [variant(), variant()] })))).toBe('variants.1.sku');
  });

  it('refuses a "before" price that is not higher than the price (no fake discounts)', () => {
    expect(fieldOf(() => parseProductInput(product({ variants: [variant({ compareAtPrice: 499_000 })] })))).toBe(
      'variants.0.compareAtPrice',
    );
    expect(parseProductInput(product({ variants: [variant({ compareAtPrice: 599_000 })] })).variants[0]).toMatchObject({
      compareAtPrice: 599_000,
    });
  });
});

describe('sanitizeDescription', () => {
  it('keeps the basic formatting and drops everything else', () => {
    expect(
      sanitizeDescription(
        '<h1>כותרת</h1><p style="color:red" onclick="x()">טקסט <i>נטוי</i></p><script>alert(1)</script><img src=x>',
      ),
    ).toBe('<h3>כותרת</h3><p>טקסט <em>נטוי</em></p>');
  });

  it('allows only safe links and marks them nofollow', () => {
    expect(sanitizeDescription('<p><a href="https://example.com" rel="x">קישור</a></p>')).toBe(
      '<p><a href="https://example.com" rel="nofollow noopener">קישור</a></p>',
    );
    expect(sanitizeDescription('<p><a href="javascript:alert(1)">רע</a></p>')).toBe('<p>רע</p>');
  });

  it('treats an empty editor as no description', () => {
    expect(sanitizeDescription('<p></p>')).toBe('');
  });

  it('gives search the words without tags', () => {
    expect(descriptionText('<h3>מידות</h3><ul><li>רוחב&nbsp;300</li><li>A &amp; B</li></ul>')).toBe(
      'מידות רוחב 300 A & B',
    );
  });
});

describe('structure inputs', () => {
  it('accepts a color swatch only as #rrggbb', () => {
    expect(parseAttributeValueInput({ code: 'Sand', labelHe: 'חול', swatchHex: '#D8C3A5', sortOrder: 0 })).toEqual({
      code: 'sand',
      labelHe: 'חול',
      swatchHex: '#d8c3a5',
      sortOrder: 0,
    });
    expect(fieldOf(() => parseAttributeValueInput({ code: 'x', labelHe: 'x', swatchHex: 'red', sortOrder: 0 }))).toBe(
      'swatchHex',
    );
  });

  it('needs at least two different words in a synonym group', () => {
    expect(parseSynonymTerms({ terms: [' ספה ', 'sofa', 'ספה'] })).toEqual(['ספה', 'sofa']);
    expect(fieldOf(() => parseSynonymTerms({ terms: ['ספה', 'ספה'] }))).toBe('terms');
  });
});

describe('activationProblems', () => {
  it('needs an active variant and a visible category', () => {
    const variants = [{ ...variant(), active: false }] as AdminVariant[];
    expect(activationProblems({ variants }, false)).toEqual(['no_variants', 'category_hidden']);
    expect(activationProblems({ variants: [variant() as AdminVariant] }, true)).toEqual([]);
  });
});

describe('changedFields', () => {
  it('keeps only what changed', () => {
    expect(changedFields({ price: 1, stock: 2, sku: 'A' }, { price: 3, stock: 2, sku: 'A' })).toEqual({
      before: { price: 1 },
      after: { price: 3 },
    });
    expect(changedFields({ a: [1] }, { a: [1] })).toBeNull();
  });
});
