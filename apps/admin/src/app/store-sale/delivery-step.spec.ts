import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { CustomerAddressView } from '@hg/models';
import { DeliveryStep } from './delivery-step';
import type { DeliveryChoice } from './steps';

const address = (id: string, isDefault: boolean, street: string): CustomerAddressView => ({
  id,
  localityId: 4000,
  localityNameHe: 'חיפה',
  street,
  houseNumber: '5',
  apartment: '2',
  floor: 3,
  hasElevator: true,
  notes: null,
  isDefault,
});

describe('store sale delivery step', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('prefills the default address and asks the store-cart quote for it', async () => {
    const fixture = TestBed.createComponent(DeliveryStep);
    fixture.detectChanges();
    http
      .expectOne('/api/admin/store-cart/customer/addresses')
      .flush([address('a1', true, 'הרצל'), address('a2', false, 'הנביאים')]);
    await fixture.whenStable();
    const quote = http.expectOne('/api/admin/store-cart/shipping-quote');
    expect(quote.request.body).toEqual({ localityId: 4000, floor: 3, hasElevator: true });
    quote.flush({
      methods: [
        { method: 'curbside', total: 15_000, lines: [] },
        { method: 'full_service', total: 30_000, lines: [] },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLInputElement>('input[name="street"]')!.value).toBe('הרצל');
    expect(el.querySelector<HTMLInputElement>('input[name="locality"]')!.value).toBe('חיפה');
    expect(el.querySelectorAll('[role="radio"]')).toHaveLength(2);
    const chosen = vi.fn<(c: DeliveryChoice) => void>();
    fixture.componentInstance.chosen.subscribe(chosen);
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('המשך לסיכום'))!.click();
    expect(chosen).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'curbside', shippingTotal: 15_000, saveAddress: false }),
    );
    expect(chosen.mock.calls[0][0].address).toMatchObject({ localityId: 4000, street: 'הרצל', floor: 3 });
  });

  it('cannot continue before a quote exists', async () => {
    const fixture = TestBed.createComponent(DeliveryStep);
    fixture.detectChanges();
    http.expectOne('/api/admin/store-cart/customer/addresses').flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    const next = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('המשך לסיכום'),
    )!;
    expect(next.disabled).toBe(true);
  });
});
