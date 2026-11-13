import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { OrderStatusPage } from './order-status.page';

describe('OrderStatusPage (/order-status, SHP-05)', () => {
  let fixture: ComponentFixture<OrderStatusPage>;
  let http: HttpTestingController;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const fill = (id: string, value: string) => {
    const input = q(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const submit = async () => {
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const alertText = () => q<HTMLElement>('.form-error[role="alert"]').textContent?.trim();

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(OrderStatusPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await settle();
  });

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('is a noindex page "מצב ההזמנה שלי" with a labelled number and phone field', () => {
    expect(metaSet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'מצב ההזמנה שלי', path: '/order-status', noindex: true }),
    );
    expect(q<HTMLElement>('h1').textContent?.trim()).toBe('מצב ההזמנה שלי');
    expect(q<HTMLLabelElement>('label[for="os-number"]').textContent?.trim()).toBe('מספר הזמנה');
    expect(q<HTMLLabelElement>('label[for="os-phone"]').textContent?.trim()).toBe('טלפון נייד');
    expect(q('#os-number').getAttribute('inputmode')).toBe('numeric');
    expect(q('#os-number').getAttribute('dir')).toBe('ltr');
    expect(q('#os-phone').type).toBe('tel');
    expect(q('#os-phone').getAttribute('dir')).toBe('ltr');
    expect(q<HTMLButtonElement>('button[type="submit"]').textContent?.trim()).toBe('הצגת ההזמנה');
    // Nothing is read until the customer asks.
    http.expectNone('/api/orders/lookup');
  });

  it('asks for both fields first: errors tied to their fields, focus on the first, nothing sent', async () => {
    await submit();
    http.expectNone('/api/orders/lookup');
    const number = q('#os-number');
    expect(number.getAttribute('aria-invalid')).toBe('true');
    expect(number.getAttribute('aria-describedby')).toBe('os-number-error');
    expect(q<HTMLElement>('#os-number-error').textContent?.trim()).toBe('יש להזין את מספר ההזמנה');
    expect(q('#os-phone').getAttribute('aria-describedby')).toBe('os-phone-error');
    expect(q<HTMLElement>('#os-phone-error').textContent?.trim()).toBe('יש להזין את מספר הטלפון');
    expect(document.activeElement).toBe(number);
    fill('os-number', '100001');
    expect(el().querySelector('#os-number-error')).toBeNull();
  });

  it('sends the number and phone and opens the order page it answers', async () => {
    fill('os-number', ' 100001 ');
    fill('os-phone', '050-1234567');
    await submit();
    const req = http.expectOne('/api/orders/lookup');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ number: '100001', phone: '050-1234567' });
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    req.flush({ url: '/order/100001?t=abc' });
    await settle();
    expect(navigateByUrl).toHaveBeenCalledWith('/order/100001?t=abc');
  });

  it('shows the one generic message for a miss, announced, and lets the customer try again', async () => {
    fill('os-number', '100001');
    fill('os-phone', '0509999999');
    await submit();
    http
      .expectOne('/api/orders/lookup')
      .flush(
        { statusCode: 404, code: 'not_found', messageHe: 'לא מצאנו הזמנה עם הפרטים האלה' },
        { status: 404, statusText: 'Not Found' },
      );
    await settle();
    expect(alertText()).toBe('לא מצאנו הזמנה עם הפרטים האלה');
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    // Changing a field clears the old answer.
    fill('os-phone', '0501234567');
    expect(alertText()).toBe('');
  });

  it('says when there were too many attempts', async () => {
    fill('os-number', '100001');
    fill('os-phone', '0501234567');
    await submit();
    http
      .expectOne('/api/orders/lookup')
      .flush({ statusCode: 429, code: 'too_many_requests' }, { status: 429, statusText: 'Too Many Requests' });
    await settle();
    expect(alertText()).toBe('ביצעתם יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.');
  });

  it('says when something else went wrong', async () => {
    fill('os-number', '100001');
    fill('os-phone', '0501234567');
    await submit();
    http.expectOne('/api/orders/lookup').flush('down', { status: 500, statusText: 'Server Error' });
    await settle();
    expect(alertText()).toBe('משהו השתבש. נסו שוב.');
  });
});
