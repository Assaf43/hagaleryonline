import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { AdminVatRate } from '@hg/models';
import { VatPage } from './vat.page';

const URL = '/api/admin/settings/vat';
const RATES: AdminVatRate[] = [
  { id: 1, rate: 0.17, effectiveFrom: '2015-10-01' },
  { id: 2, rate: 0.18, effectiveFrom: '2025-01-01' },
];
const RATE_MESSAGE = 'שיעור המע"מ חייב להיות גדול מ־0% וקטן מ־100%, עד 2 ספרות אחרי הנקודה.';

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('VatPage ("מע"מ")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(VatPage);
    fixture.detectChanges();
    http.expectOne(URL).flush(RATES);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const type = async (name: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(fixture);
    };
    const submit = async () => {
      el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
    };
    return { fixture, el, type, submit };
  }

  it('lists the rates with their percent and start date', async () => {
    const { el } = await open();
    const rows = [...el.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((td) => td.textContent?.trim()),
    );
    expect(rows).toEqual([
      ['17%', '1.10.2015'],
      ['18%', '1.1.2025'],
    ]);
  });

  it('adds a rate as a fraction, then reloads the list', async () => {
    const { fixture, el, type, submit } = await open();
    await type('rate', '17.5');
    await type('effectiveFrom', '2027-01-01');
    await submit();
    const req = http.expectOne((r) => r.method === 'POST' && r.url === URL);
    expect(req.request.body).toEqual({ rate: 0.175, effectiveFrom: '2027-01-01' });
    req.flush({ id: 3, rate: 0.175, effectiveFrom: '2027-01-01' });
    await settle(fixture);
    http.expectOne((r) => r.method === 'GET').flush([...RATES, { id: 3, rate: 0.175, effectiveFrom: '2027-01-01' }]);
    await settle(fixture);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(el.querySelector('.error')).toBeNull();
  });

  it('refuses a percent with more than 2 decimals without rounding or sending it', async () => {
    const { el, type, submit } = await open();
    await type('rate', '17.555');
    await type('effectiveFrom', '2027-01-01');
    await submit();
    http.expectNone((r) => r.method === 'POST');
    expect(el.querySelector('.error')?.textContent).toContain(RATE_MESSAGE);
  });

  it('shows the 409 message when a rate already starts on that date', async () => {
    const { fixture, el, type, submit } = await open();
    await type('rate', '19');
    await type('effectiveFrom', '2027-01-01');
    await submit();
    http
      .expectOne((r) => r.method === 'POST')
      .flush({ code: 'vat_rate_exists' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('.error')?.textContent).toContain('כבר יש שיעור מע"מ שמתחיל בתאריך הזה.');
  });
});
