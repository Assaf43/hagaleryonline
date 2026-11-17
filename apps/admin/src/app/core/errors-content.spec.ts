import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage } from './errors';

const conflict = (url: string) =>
  new HttpErrorResponse({ status: 409, url, error: { code: 'conflict' }, statusText: 'Conflict' });

describe('conflict wording', () => {
  it('content screens do not talk about a product', () => {
    const text = errorMessage(conflict('/api/admin/content/pages/4'));
    expect(text).toContain('הדף הזה');
    expect(text).not.toContain('המוצר');
  });

  it('product screens keep the catalog wording', () => {
    expect(errorMessage(conflict('/api/admin/catalog/products/4'))).toContain('המוצר');
  });
});

const refused = (url: string, status: number, error: object) =>
  new HttpErrorResponse({ status, url, error, statusText: 'x' });

describe('banner and home page errors', () => {
  it('names the sections that use a banner', () => {
    const text = errorMessage(
      refused('/api/admin/content/banners/3', 409, { code: 'banner_in_use', sections: ['באנר ראשי', 'באנרים למטה'] }),
    );
    expect(text).toContain('"באנר ראשי", "באנרים למטה"');
  });

  it('explains a promotion that cannot be a product source', () => {
    const text = errorMessage(
      refused('/api/admin/content/home', 400, { code: 'invalid_source', field: 'sections.2.source' }),
    );
    expect(text).toContain('מבצע');
    expect(text).toContain('אוטומטי');
  });

  it('gives the content photo reasons, with the 1200 px minimum', () => {
    const upload = (value: string) =>
      errorMessage(refused('/api/admin/content/images', 400, { code: 'invalid', field: 'file', value }));
    expect(upload('too_small')).toContain('1200');
    expect(upload('type')).toContain('JPG');
    expect(upload('too_large')).toContain('15MB');
  });

  it('keeps the catalog photo minimum on the product screens', () => {
    const text = errorMessage(
      refused('/api/admin/catalog/products/1/images', 400, { code: 'invalid', field: 'file', value: 'too_small' }),
    );
    expect(text).toContain('600');
  });

  it('names a banner field and a home place', () => {
    expect(errorMessage(refused('/api/admin/content/banners', 400, { code: 'invalid', field: 'imageId' }))).toContain(
      'תמונה',
    );
    expect(
      errorMessage(refused('/api/admin/content/home', 400, { code: 'invalid', field: 'sections.3.count' })),
    ).toContain('מקום 4');
  });

  it('does not touch catalog fields of the same name', () => {
    const text = errorMessage(refused('/api/admin/catalog/categories/2', 400, { code: 'invalid', field: 'nameHe' }));
    expect(text).toContain('שם');
    expect(text).not.toContain('פנימי');
  });
});
