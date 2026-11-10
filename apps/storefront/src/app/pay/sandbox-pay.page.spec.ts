import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import type { SandboxPaymentView } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { SandboxPayPage } from './sandbox-pay.page';

const VIEW: SandboxPaymentView = { transactionId: 'abc', orderNumber: 100001, amount: 345000, status: 'pending' };
const URL = '/api/payments/sandbox/abc';
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('SandboxPayPage', () => {
  let fixture: ComponentFixture<SandboxPayPage>;
  let http: HttpTestingController;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (label: string) =>
    Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;
  const render = async () => {
    await settle();
    fixture.detectChanges();
  };

  async function setup(view: SandboxPaymentView | 404 = VIEW) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(SandboxPayPage);
    fixture.componentRef.setInput('transactionId', 'abc');
    fixture.detectChanges();
    const req = http.expectOne(URL);
    if (view === 404) req.flush({ statusCode: 404, code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    else req.flush(view);
    await render();
  }

  afterEach(() => {
    http.verify();
  });

  it('sets a noindex title', async () => {
    await setup();
    expect(metaSet).toHaveBeenCalledWith(expect.objectContaining({ path: '/pay/sandbox', noindex: true }));
  });

  it('shows the test banner, the order and the amount', async () => {
    await setup();
    expect(el().querySelector('.banner')?.textContent).toContain('סביבת בדיקה — אין חיוב אמיתי');
    expect(el().textContent).toContain('3,450 ₪');
    expect(el().textContent).toContain('100001');
    const options = Array.from(el().querySelectorAll('select#sandbox-installments option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(el().querySelector('label[for="sandbox-installments"]')).not.toBeNull();
  });

  for (const [label, outcome] of [
    ['תשלום מצליח', 'success'],
    ['תשלום נכשל', 'failure'],
    ['ביטול', 'cancel'],
  ] as const) {
    it(`"${label}" posts ${outcome} with the installments and opens the confirmation`, async () => {
      await setup();
      const select = el().querySelector<HTMLSelectElement>('select')!;
      select.value = '3';
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
      button(label).click();
      const req = http.expectOne(`${URL}/complete`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ outcome, installments: 3 });
      req.flush({ confirmationUrl: '/order/100001?t=tok' });
      await render();
      expect(navigateByUrl).toHaveBeenCalledWith('/order/100001?t=tok');
    });
  }

  it('shows the API error when the transaction is not found', async () => {
    await setup(404);
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('העסקה לא נמצאה');
    expect(button('תשלום מצליח')).toBeUndefined();
  });

  it('disables the outcome buttons once the payment is no longer pending', async () => {
    await setup({ ...VIEW, status: 'succeeded' });
    expect(el().textContent).toContain('התשלום הזה כבר טופל.');
    for (const label of ['תשלום מצליח', 'תשלום נכשל', 'ביטול']) expect(button(label).disabled).toBe(true);
    button('תשלום מצליח').click();
    http.expectNone(`${URL}/complete`);
  });

  it('explains a malformed request', async () => {
    await setup();
    button('ביטול').click();
    http
      .expectOne(`${URL}/complete`)
      .flush({ statusCode: 400, code: 'invalid_input' }, { status: 400, statusText: 'Bad Request' });
    await render();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('הנתונים שנשלחו לא תקינים. נסו שוב.');
  });

  it('shows an error when completing fails', async () => {
    await setup();
    button('תשלום מצליח').click();
    http
      .expectOne(`${URL}/complete`)
      .flush({ statusCode: 502, code: 'payment_unavailable' }, { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('לא הצלחנו');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
