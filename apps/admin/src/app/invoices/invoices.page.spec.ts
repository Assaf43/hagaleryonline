import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminInvoicesMonth, AdminVatRate } from '@hg/models';
import { israelMonthOf, shiftMonth } from '../promotions/israel-time';
import { InvoicesPage } from './invoices.page';
import { VatPage } from '../settings/vat.page';

const NOVEMBER: AdminInvoicesMonth = {
  month: '2026-11',
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'tax_invoice_receipt',
      number: 'MOCK-INV-000001',
      orderNumber: 100123,
      issuedAt: '2026-11-05T22:30:00.000Z',
      amount: 105_000,
      vatAmount: 16_017,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      type: 'credit_note',
      number: 'MOCK-CRN-000001',
      orderNumber: 100123,
      issuedAt: '2026-11-12T09:00:00.000Z',
      amount: 11_800,
      vatAmount: 1_800,
    },
  ],
  totals: { sales: 105_000, credits: 11_800, net: 93_200, vat: 14_217 },
};

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};
const flat = (text: string | null | undefined) => (text ?? '').replace(/[‎‏\s]/g, '');

describe('Israel months', () => {
  it('the month of an instant is by Israel time', () => {
    expect(israelMonthOf(new Date('2026-12-31T22:30:00.000Z'))).toBe('2027-01');
    expect(israelMonthOf(new Date('2026-11-30T21:59:00.000Z'))).toBe('2026-11');
  });
  it('shifts across years', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-11', 0)).toBe('2026-11');
  });
});

describe('InvoicesPage ("חשבוניות")', () => {
  let http: HttpTestingController;
  const thisMonth = israelMonthOf(new Date());

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(InvoicesPage);
    fixture.detectChanges();
    http.expectOne(`/api/admin/invoices?month=${thisMonth}`).flush({ ...NOVEMBER, month: thisMonth });
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('opens on the current Israel month and shows rows, links and totals', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('חשבוניות');
    const rows = el.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(flat(rows[0].textContent)).toContain('חשבוניתמס/קבלה');
    expect(flat(rows[0].textContent)).toContain('MOCK-INV-000001');
    expect(flat(rows[0].textContent)).toContain('6.11.2026');
    expect(flat(rows[0].textContent)).toContain('1,050');
    expect(flat(rows[1].textContent)).toContain('חשבוניתזיכוי');
    expect(rows[0].querySelector('a[href="/orders/100123"]')).not.toBeNull();
    const doc = rows[0].querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(doc?.getAttribute('href')).toBe('/api/admin/invoices/11111111-1111-4111-8111-111111111111/document');
    const totals = flat(el.querySelector('tfoot')?.textContent);
    expect(totals).toContain('1,050');
    expect(totals).toContain('118');
    expect(totals).toContain('932');
    expect(totals).toContain('142.17');
  });

  it('previous and next month reload the list', async () => {
    const { fixture, el } = await open();
    const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.month-nav button'));
    buttons()
      .find((b) => b.textContent?.includes('החודש הקודם'))!
      .click();
    const previous = shiftMonth(thisMonth, -1);
    http.expectOne(`/api/admin/invoices?month=${previous}`).flush({ ...NOVEMBER, month: previous, items: [] });
    await settle(fixture);
    expect(el.querySelector('.empty')?.textContent).toContain('אין מסמכים');
    expect(el.querySelector<HTMLInputElement>('input[type="month"]')?.value).toBe(previous);

    buttons()
      .find((b) => b.textContent?.includes('החודש הבא'))!
      .click();
    http.expectOne(`/api/admin/invoices?month=${thisMonth}`).flush({ ...NOVEMBER, month: thisMonth });
    await settle(fixture);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('picking a month in the field reloads the list', async () => {
    const { fixture, el } = await open();
    const input = el.querySelector<HTMLInputElement>('input[type="month"]')!;
    input.value = '2026-03';
    input.dispatchEvent(new Event('change'));
    http.expectOne('/api/admin/invoices?month=2026-03').flush({ ...NOVEMBER, month: '2026-03', items: [] });
    await settle(fixture);
    expect(el.querySelector('.empty')).not.toBeNull();
  });

  it('"ייצוא לרואה החשבון" downloads the month as a file', async () => {
    const { fixture, el } = await open();
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      created.push(b as Blob);
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Array.from(el.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('ייצוא לרואה החשבון'))!
      .click();
    const req = http.expectOne(`/api/admin/invoices/export?month=${thisMonth}`);
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['x']), {
      headers: { 'content-disposition': `attachment; filename="invoices-${thisMonth}.xlsx"` },
    });
    await settle(fixture);
    expect(created).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('VatPage ("מע״מ")', () => {
  let http: HttpTestingController;
  const RATES: AdminVatRate[] = [{ id: 1, rate: 0.18, effectiveFrom: '2025-01-01' }];

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(VatPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/settings/vat').flush(RATES);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the rates and adds a future one (percent → fraction)', async () => {
    const { fixture, el } = await open();
    expect(flat(el.querySelector('tbody')?.textContent)).toContain('18%');
    expect(flat(el.querySelector('tbody')?.textContent)).toContain('1.1.2025');

    const rate = el.querySelector<HTMLInputElement>('input[name="rate"]')!;
    const date = el.querySelector<HTMLInputElement>('input[name="effectiveFrom"]')!;
    rate.value = '19';
    rate.dispatchEvent(new Event('input'));
    date.value = '2099-01-01';
    date.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));

    const req = http.expectOne('/api/admin/settings/vat');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ rate: 0.19, effectiveFrom: '2099-01-01' });
    req.flush({ id: 2, rate: 0.19, effectiveFrom: '2099-01-01' }, { status: 201, statusText: 'Created' });
    await settle(fixture);
    http.expectOne('/api/admin/settings/vat').flush([...RATES, { id: 2, rate: 0.19, effectiveFrom: '2099-01-01' }]);
    await settle(fixture);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('shows the server refusal in Hebrew and keeps the form', async () => {
    const { fixture, el } = await open();
    const rate = el.querySelector<HTMLInputElement>('input[name="rate"]')!;
    const date = el.querySelector<HTMLInputElement>('input[name="effectiveFrom"]')!;
    rate.value = '19';
    rate.dispatchEvent(new Event('input'));
    date.value = '2099-01-01';
    date.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    http
      .expectOne('/api/admin/settings/vat')
      .flush({ code: 'vat_rate_exists' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('כבר יש שיעור');
    expect(rate.value).toBe('19');
  });
});
