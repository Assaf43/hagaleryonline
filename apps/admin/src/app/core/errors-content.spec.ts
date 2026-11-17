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
