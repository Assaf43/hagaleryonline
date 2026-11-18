import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ProductSource } from '@hg/models';
import { ProductSourceField } from './product-source-field';

function create(source: ProductSource) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(ProductSourceField);
  fixture.componentRef.setInput('source', source);
  fixture.componentRef.setInput('promotions', [{ id: 5, label: 'מבצע ספות' }]);
  fixture.detectChanges();
  const field = fixture.componentInstance as unknown as {
    setKind(kind: ProductSource['kind']): void;
    setId(id: number): void;
    setPicks(picks: unknown[]): void;
    source(): ProductSource;
    withCurrent(o: { id: number; label: string }[]): { id: number; label: string }[];
  };
  return { fixture, field, el: fixture.nativeElement as HTMLElement };
}

describe('product source field', () => {
  it('has no extra settings for best sellers and newest', () => {
    const { field, el } = create({ kind: 'bestsellers' });
    expect(el.querySelector('hg-product-relations')).toBeNull();
    field.setKind('newest');
    expect(field.source()).toEqual({ kind: 'newest' });
  });

  it('starts a category, room or promotion with nothing chosen, then keeps the id', () => {
    const { field } = create({ kind: 'bestsellers' });
    field.setKind('promotion');
    expect(field.source()).toEqual({ kind: 'promotion', id: 0 });
    field.setId(5);
    expect(field.source()).toEqual({ kind: 'promotion', id: 5 });
    field.setKind('room');
    expect(field.source()).toEqual({ kind: 'room', id: 0 });
  });

  it('shows the product search for a manual source and keeps the ids in the picked order', () => {
    const { fixture, field, el } = create({ kind: 'bestsellers' });
    field.setKind('manual');
    fixture.detectChanges();
    expect(el.querySelector('hg-product-relations')).not.toBeNull();
    const pick = (id: number) => ({ id, modelName: 'M' + id, nameHe: 'ש', active: true, thumbnailUrl: null });
    field.setPicks([pick(9), pick(2)]);
    expect(field.source()).toEqual({ kind: 'manual', productIds: [9, 2] });
  });

  it('keeps a saved id that is no longer in the list, marked as not found', () => {
    const { field } = create({ kind: 'category', id: 77 });
    expect(field.withCurrent([{ id: 1, label: 'ספות' }])[0]).toEqual({ id: 77, label: '#77 (לא נמצא)' });
  });

  it('marks a source the site cannot show', () => {
    const { fixture, el } = create({ kind: 'promotion', id: 5 });
    fixture.componentRef.setInput('unavailable', true);
    fixture.detectChanges();
    expect(el.querySelector('.mark-note')?.textContent).toContain('לא מוצג באתר');
  });

  it('keeps the manual picker disabled while the saved names load', () => {
    const { fixture, el } = create({ kind: 'manual', productIds: [4, 8] });
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('hg-product-relations input[type="search"]')?.disabled).toBe(true);
    fixture.componentRef.setInput('loading', false);
    fixture.detectChanges();
    expect(el.querySelector<HTMLInputElement>('hg-product-relations input[type="search"]')?.disabled).toBe(false);
  });
});
