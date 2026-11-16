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
    const next = () =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('המשך לסיכום'))!;
    // Two methods are offered: none is chosen for the seller.
    expect(next().disabled).toBe(true);
    el.querySelector<HTMLButtonElement>('[role="radio"]')!.click();
    fixture.detectChanges();
    expect(next().disabled).toBe(false);
    const chosen = vi.fn<(c: DeliveryChoice) => void>();
    fixture.componentInstance.chosen.subscribe(chosen);
    next().click();
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

  const withDefault = async (methods: { method: string; total: number; lines: [] }[]) => {
    const fixture = TestBed.createComponent(DeliveryStep);
    fixture.detectChanges();
    http.expectOne('/api/admin/store-cart/customer/addresses').flush([address('a1', true, 'הרצל')]);
    await fixture.whenStable();
    http.expectOne('/api/admin/store-cart/shipping-quote').flush({ methods });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };
  const curbside = { method: 'curbside', total: 15_000, lines: [] as [] };
  const full = { method: 'full_service', total: 30_000, lines: [] as [] };

  it('preselects the method only when exactly one is offered', async () => {
    const fixture = await withDefault([curbside]);
    const next = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('המשך לסיכום'),
    )!;
    expect(next.disabled).toBe(false);
  });

  it('clears the saved choice and restores "save address" when a field is edited', async () => {
    const fixture = await withDefault([curbside]);
    const el = fixture.nativeElement as HTMLElement;
    const save = () => el.querySelector<HTMLInputElement>('input[name="saveAddress"]')!;
    const saved = () => el.querySelector<HTMLButtonElement>('[aria-label="כתובות שמורות"] .pick')!;
    expect(saved().getAttribute('aria-pressed')).toBe('true');
    expect(save().checked).toBe(false);
    const street = el.querySelector<HTMLInputElement>('input[name="street"]')!;
    street.value = 'אחר';
    street.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(saved().getAttribute('aria-pressed')).toBe('false');
    expect(save().checked).toBe(true);
  });

  it('works the locality combobox with arrows, Enter and Escape', async () => {
    const fixture = await withDefault([curbside]);
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('input[name="locality"]')!;
    input.value = 'חי';
    input.dispatchEvent(new Event('input'));
    http
      .expectOne((r) => r.url === '/api/localities' && r.params.get('q') === 'חי')
      .flush([
        { id: 1, nameHe: 'חיפה' },
        { id: 2, nameHe: 'חדרה' },
      ]);
    await fixture.whenStable();
    fixture.detectChanges();
    const key = (k: string) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true }));
      fixture.detectChanges();
    };
    expect(input.getAttribute('aria-controls')).toBe('store-locality-list');
    expect(el.querySelector('#store-locality-list')?.getAttribute('role')).toBe('listbox');
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(2);
    key('ArrowDown');
    key('ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe('store-locality-1');
    expect(el.querySelector('#store-locality-1')?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(input.getAttribute('aria-activedescendant')).toBe('store-locality-0');
    key('Escape');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    input.dispatchEvent(new Event('input'));
    http.expectOne((r) => r.url === '/api/localities').flush([{ id: 2, nameHe: 'חדרה' }]);
    await fixture.whenStable();
    fixture.detectChanges();
    key('ArrowDown');
    key('Enter');
    expect(input.value).toBe('חדרה');
    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('moves between shipping methods with the arrow keys, one tab stop', async () => {
    const fixture = await withDefault([curbside, full]);
    const el = fixture.nativeElement as HTMLElement;
    const radios = () => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    radios()[0].click();
    fixture.detectChanges();
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1]);
    radios()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    fixture.detectChanges();
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0]);
    radios()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    fixture.detectChanges();
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');
  });
});
