import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { AdminProductRow, RelatedPick } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { ProductRelations } from './product-relations';

const row = (id: number, modelName: string, over: Partial<AdminProductRow> = {}): AdminProductRow => ({
  id,
  slug: modelName.toLowerCase(),
  modelName,
  nameHe: `ספה ${modelName}`,
  categoryId: 1,
  active: true,
  variantCount: 1,
  priceFrom: 250000,
  totalStock: 3,
  updatedAt: '2026-01-01T00:00:00Z',
  thumbnailUrl: null,
  ...over,
});

const pick = (id: number, modelName: string, active = true): RelatedPick => ({
  id,
  modelName,
  nameHe: `ספה ${modelName}`,
  active,
  thumbnailUrl: null,
});

describe('ProductRelations', () => {
  let fixture: ComponentFixture<ProductRelations>;
  let products: ReturnType<typeof vi.fn>;

  const el = () => fixture.nativeElement as HTMLElement;
  const picks = () => fixture.componentInstance.picks();
  const names = () => [...el().querySelectorAll('.picked .model')].map((e) => e.textContent!.trim());

  async function search(text: string) {
    const input = el().querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    fixture.detectChanges();
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(initial: RelatedPick[] = [], productId: number | null = 1) {
    products = vi.fn().mockResolvedValue({
      items: [row(1, 'SELF'), row(2, 'ALBA'), row(3, 'BORA'), row(4, 'CIRO')],
      total: 4,
      page: 1,
      pageSize: 20,
    });
    TestBed.configureTestingModule({
      providers: [{ provide: CatalogApi, useValue: { products } }],
    });
    fixture = TestBed.createComponent(ProductRelations);
    fixture.componentRef.setInput('productId', productId);
    fixture.componentRef.setInput('title', 'הולך מושלם עם');
    fixture.componentRef.setInput('picks', initial);
    fixture.componentRef.setInput('autofill', false);
    fixture.detectChanges();
  }

  it('excludes self and picked products from results', async () => {
    setup([pick(3, 'BORA')]);
    await search('al');
    const found = [...el().querySelectorAll('.results .model')].map((e) => e.textContent!.trim());
    expect(found).toEqual(['ALBA', 'CIRO']);
    expect(products).toHaveBeenCalledWith({ q: 'al', status: 'all', page: 1 });
  });

  it('ignores Enter while a newer query is pending', async () => {
    setup();
    await search('LU');
    expect(el().querySelectorAll('.results .model').length).toBeGreaterThan(0);
    const input = el().querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'LUX';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    fixture.detectChanges();
    expect(picks()).toEqual([]);
  });

  it('does not search below two characters', async () => {
    setup();
    await search('a');
    expect(products).not.toHaveBeenCalled();
  });

  it('adds on click and emits picks', async () => {
    setup();
    await search('al');
    el().querySelector<HTMLButtonElement>('.results button.result')!.click();
    fixture.detectChanges();
    expect(picks().map((p) => p.modelName)).toEqual(['ALBA']);
    expect(names()).toEqual(['ALBA']);
  });

  it('moves up/down', () => {
    setup([pick(2, 'ALBA'), pick(3, 'BORA'), pick(4, 'CIRO')]);
    const buttons = () => [...el().querySelectorAll<HTMLButtonElement>('.picked li')];
    buttons()[2].querySelector<HTMLButtonElement>('button[aria-label^="הזזה למעלה"]')!.click();
    fixture.detectChanges();
    expect(picks().map((p) => p.modelName)).toEqual(['ALBA', 'CIRO', 'BORA']);
    buttons()[0].querySelector<HTMLButtonElement>('button[aria-label^="הזזה למטה"]')!.click();
    fixture.detectChanges();
    expect(picks().map((p) => p.modelName)).toEqual(['CIRO', 'ALBA', 'BORA']);
  });

  it('removes', () => {
    setup([pick(2, 'ALBA'), pick(3, 'BORA')]);
    el().querySelector<HTMLButtonElement>('.picked li button[aria-label^="הסרה"]')!.click();
    fixture.detectChanges();
    expect(picks().map((p) => p.modelName)).toEqual(['BORA']);
  });

  it('shows מוסתר for inactive picks', () => {
    setup([pick(2, 'ALBA', false), pick(3, 'BORA')]);
    const badges = [...el().querySelectorAll('.picked .badge')].map((e) => e.textContent!.trim());
    expect(badges).toEqual(['מוסתר']);
  });

  it('autofill checkbox updates the model', () => {
    setup();
    el().querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.autofill()).toBe(true);
  });
});
