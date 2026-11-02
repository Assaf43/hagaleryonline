import { fieldLabel } from '../core/errors';
import { categoryOptions, suggestSlug, toAgorot, toShekels } from './catalog-format';

describe('catalog-format', () => {
  it('suggests a slug from the model name and the category in the singular', () => {
    expect(suggestSlug('ALBA', 'corner-sofas')).toBe('alba-corner-sofa');
    expect(suggestSlug('Tal 2', 'sideboards')).toBe('tal-2-sideboard');
    expect(suggestSlug('ORI', undefined)).toBe('ori');
  });

  it('converts shekels to agorot without floating-point drift', () => {
    expect(toAgorot(4490)).toBe(449_000);
    expect(toAgorot(19.99)).toBe(1999);
    expect(toAgorot(null)).toBeNull();
    expect(toShekels(449_000)).toBe(4490);
  });

  it('lists sub-categories under their parent', () => {
    const base = { sortOrder: 0, active: true, attributeCodes: [], productCount: 0 };
    const options = categoryOptions([
      { ...base, id: 1, slug: 'sofas', nameHe: 'ספות', parentId: null },
      { ...base, id: 2, slug: 'corner-sofas', nameHe: 'פינתיות', parentId: 1 },
      { ...base, id: 3, slug: 'rugs', nameHe: 'שטיחים', parentId: null },
    ]);
    expect(options.map((o) => o.label)).toEqual(['ספות', 'ספות › פינתיות', 'שטיחים']);
  });

  it('names the field and row the API points at', () => {
    expect(fieldLabel('variants.3.price')).toBe('מחיר בשורה 4');
    expect(fieldLabel('slug')).toBe('כתובת באתר');
  });
});
