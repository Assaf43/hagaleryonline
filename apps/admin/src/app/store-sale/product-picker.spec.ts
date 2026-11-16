import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ProductDetail, StoreCartView } from '@hg/models';
import { ProductPicker, matchVariant } from './product-picker';

const product = {
  slug: 'alba',
  modelName: 'ALBA',
  nameHe: 'ספה',
  optionAxes: [
    {
      code: 'color',
      nameHe: 'צבע',
      values: [
        { code: 'beige', labelHe: 'בז׳', hex: null },
        { code: 'gray', labelHe: 'אפור', hex: null },
      ],
    },
  ],
  variants: [
    { id: 11, sku: 'ALBA-B', price: 500_000, inStock: true, options: { color: 'beige' } },
    { id: 12, sku: 'ALBA-G', price: 520_000, inStock: true, options: { color: 'gray' } },
  ],
} as unknown as ProductDetail;

const cart = (quantity: number): StoreCartView =>
  ({
    lines: [
      {
        variantId: 12,
        modelName: 'ALBA',
        nameHe: 'ספה',
        optionLabels: [],
        quantity,
        lineTotal: quantity * 520_000,
        maxQuantity: 5,
        available: true,
        unavailableReason: null,
      },
    ],
    notices: [],
    subtotal: quantity * 520_000,
    discount: null,
    couponCode: null,
    pricing: 'regular',
    memberSavings: null,
    customer: null,
  }) as unknown as StoreCartView;

const settle = async (f: ComponentFixture<unknown>) => {
  await f.whenStable();
  f.detectChanges();
};

describe('store sale product picker', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<ProductPicker>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ProductPicker);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('matches a variant only when every axis is chosen', () => {
    expect(matchVariant(product, {})).toBeNull();
    expect(matchVariant(product, { color: 'gray' })?.id).toBe(12);
  });

  it('adds the chosen variant with the typed quantity', async () => {
    const input = el().querySelector<HTMLInputElement>('input[name="q"]')!;
    input.value = 'alba';
    input.dispatchEvent(new Event('input'));
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    http
      .expectOne((r) => r.url === '/api/search/suggest' && r.params.get('q') === 'alba')
      .flush({
        products: [{ slug: 'alba', modelName: 'ALBA', nameHe: 'ספה', priceFrom: 500_000, image: null }],
        categories: [],
      });
    await settle(fixture);
    el().querySelector<HTMLButtonElement>('.pick')!.click();
    http.expectOne('/api/products/alba').flush(product);
    await settle(fixture);
    const add = () =>
      [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('הוספה לעגלה'))!;
    expect(add().disabled).toBe(true);
    const select = el().querySelector<HTMLSelectElement>('select')!;
    select.value = 'gray';
    select.dispatchEvent(new Event('change'));
    const qty = el().querySelector<HTMLInputElement>('input[name="qty"]')!;
    qty.value = '2';
    qty.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(add().disabled).toBe(false);
    const emitted = vi.fn();
    fixture.componentInstance.cartChange.subscribe(emitted);
    add().click();
    const req = http.expectOne('/api/admin/store-cart/items');
    expect(req.request.body).toEqual({ variantId: 12, quantity: 2 });
    req.flush(cart(2));
    await settle(fixture);
    expect(emitted).toHaveBeenCalled();
  });

  it('shows the quantity the server holds after it clamps an update', async () => {
    fixture.componentRef.setInput('cart', cart(5));
    fixture.detectChanges();
    fixture.componentInstance.cartChange.subscribe((v) => fixture.componentRef.setInput('cart', v));
    const field = el().querySelector<HTMLInputElement>('.line input')!;
    field.value = '9';
    field.dispatchEvent(new Event('change'));
    http.expectOne('/api/admin/store-cart/items/12').flush(cart(5));
    await settle(fixture);
    expect(el().querySelector<HTMLInputElement>('.line input')!.value).toBe('5');
  });

  it('Enter in the coupon field applies the coupon like the button', async () => {
    fixture.componentRef.setInput('cart', cart(1));
    fixture.detectChanges();
    const input = el().querySelector<HTMLInputElement>('input[name="coupon"]')!;
    input.value = 'SAVE10';
    input.dispatchEvent(new Event('input'));
    input.closest('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/admin/store-cart/coupon');
    expect(req.request.body).toEqual({ code: 'SAVE10' });
    req.flush(cart(1));
    await settle(fixture);
  });
});
