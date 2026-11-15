import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { OrderStep, GUEST_ORDER_HINT_HE } from './order-step';
import type { SupportOrder } from './support.api';
import { deliveredOrder, failWith, setupSupport, tick } from './support.testing';

describe('OrderStep', () => {
  let fixture: ComponentFixture<OrderStep>;
  let http: HttpTestingController;
  let emitted: (SupportOrder | null)[];
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const fill = (selector: string, value: string) => {
    const input = q(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const submit = async () => {
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const alertText = () => q('.form-error[role="alert"]').textContent?.trim();

  async function open(signedIn: boolean, number?: string) {
    http = setupSupport(signedIn);
    fixture = TestBed.createComponent(OrderStep);
    document.body.appendChild(fixture.nativeElement);
    emitted = [];
    fixture.componentInstance.orderChange.subscribe((o) => emitted.push(o));
    if (number) fixture.componentRef.setInput('initialNumber', number);
    fixture.detectChanges();
    await settle();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('takes its field lengths from the shared limits', async () => {
    await open(false);
    expect(q('#os-number').getAttribute('maxlength')).toBe('12');
    expect(q('#os-phone').getAttribute('maxlength')).toBe('20');
  });

  it('a throttled lookup (429) says to try again later and keeps the form', async () => {
    await open(false);
    fill('#os-number', '100001');
    fill('#os-phone', '0501234567');
    await submit();
    await tick();
    failWith(http.expectOne('/api/orders/lookup'), 429, 'too_many_requests');
    await settle();
    expect(alertText()).toContain('יותר מדי ניסיונות');
    expect(emitted).toEqual([]);
  });

  it('a refused lookup (400) says the order details are wrong', async () => {
    await open(false);
    fill('#os-number', 'abc');
    fill('#os-phone', '0501234567');
    await submit();
    await tick();
    failWith(http.expectOne('/api/orders/lookup'), 400, 'invalid_field');
    await settle();
    expect(alertText()).toBe('יש להזין מספר הזמנה ומספר טלפון');
  });

  it('signed in: no phone field at first, but a guest-order button that reveals it', async () => {
    await open(true);
    expect(el().querySelector('#os-phone')).toBeNull();
    q<HTMLButtonElement>('button.link-btn').click();
    await settle();
    expect(q('#os-phone')).not.toBeNull();
    expect(document.activeElement).toBe(q('#os-phone'));
    expect(el().querySelector('button.link-btn')).toBeNull();
  });

  it('signed in: an account 404 reveals the phone, then the guest order is found by number + phone and the ref is emitted', async () => {
    await open(true);
    fill('#os-number', '100001');
    await submit();
    await tick();
    failWith(http.expectOne('/api/account/orders/100001'), 404, 'not_found');
    await settle();
    expect(alertText()).toBe(GUEST_ORDER_HINT_HE);
    expect(q('#os-phone')).not.toBeNull();
    fill('#os-phone', '050-123-4567');
    await submit();
    await tick();
    http.expectOne('/api/orders/lookup').flush({ url: '/order/100001?t=tok9' });
    await tick();
    const read = http.expectOne((r) => r.url === '/api/orders/100001');
    expect(read.request.params.get('t')).toBe('tok9');
    read.flush(deliveredOrder());
    await settle();
    expect(emitted.at(-1)).toMatchObject({ ref: { number: '100001', phone: '050-123-4567' } });
    expect(document.activeElement).toBe(q('#os-summary'));
  });

  it('signed in with the number in the link: the account order loads by itself, without taking focus', async () => {
    await open(true, '100001');
    http.expectOne('/api/account/orders/100001').flush(deliveredOrder());
    await settle();
    expect(emitted.at(-1)).toMatchObject({ ref: null });
    expect(document.activeElement).not.toBe(q('#os-summary'));
  });
});
