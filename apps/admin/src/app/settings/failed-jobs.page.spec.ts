import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminFailedJob } from '@hg/models';
import { FailedJobsPage } from './failed-jobs.page';

const JOBS: AdminFailedJob[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'invoice.issue',
    orderNumber: 100123,
    attempts: 8,
    lastError: 'provider timeout',
    updatedAt: '2026-11-12T10:30:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'sms.delivery_slot',
    orderNumber: null,
    attempts: 8,
    lastError: null,
    updatedAt: '2026-11-12T09:00:00.000Z',
  },
];

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('FailedJobsPage ("משימות שנכשלו")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(items: AdminFailedJob[] = JOBS) {
    const fixture = TestBed.createComponent(FailedJobsPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/jobs/failed').flush(items);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists type in Hebrew, order link, attempts, last error and time', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('משימות שנכשלו');
    const rows = [...el.querySelectorAll('.job')];
    expect(rows).toHaveLength(2);
    const [invoice, sms] = rows;
    expect(invoice.querySelector('.type')?.textContent).toContain('הפקת חשבונית');
    const link = invoice.querySelector<HTMLAnchorElement>('.order a');
    expect(link?.getAttribute('href')).toBe('/orders/100123');
    expect(link?.querySelector('bdi')?.textContent?.trim()).toBe('100123');
    expect(invoice.querySelector('.attempts')?.textContent).toContain('8');
    expect(invoice.querySelector('.error')?.textContent).toContain('provider timeout');
    expect(invoice.querySelector('.updated')?.textContent).toMatch(/12\.11\.2026/);

    expect(sms.querySelector('.type')?.textContent).toContain('SMS תיאום אספקה');
    expect(sms.querySelector('.order a')).toBeNull();
  });

  it('has a Hebrew label for every job type', async () => {
    const { el } = await open(
      (
        [
          ['email.order_paid', 'אישור הזמנה במייל'],
          ['email.status', 'עדכון סטטוס במייל'],
          ['email.cancelled', 'הודעת ביטול במייל'],
          ['email.refund', 'הודעת החזר במייל'],
          ['sms.delivery_slot', 'SMS תיאום אספקה'],
          ['invoice.issue', 'הפקת חשבונית'],
          ['invoice.credit_note', 'הפקת חשבונית זיכוי'],
          ['refund.late_payment', 'החזר תשלום מאוחר'],
        ] as const
      ).map(([type], i) => ({ ...JOBS[0], id: `id-${i}`, type })),
    );
    expect([...el.querySelectorAll('.job .type')].map((t) => t.textContent?.trim())).toEqual([
      'אישור הזמנה במייל',
      'עדכון סטטוס במייל',
      'הודעת ביטול במייל',
      'הודעת החזר במייל',
      'SMS תיאום אספקה',
      'הפקת חשבונית',
      'הפקת חשבונית זיכוי',
      'החזר תשלום מאוחר',
    ]);
  });

  it('"נסה שוב" posts the retry and removes the row', async () => {
    const { fixture, el } = await open();
    const button = el.querySelector<HTMLButtonElement>('.job button.retry')!;
    expect(button.textContent?.trim()).toBe('נסה שוב');
    button.click();
    http
      .expectOne({ method: 'POST', url: '/api/admin/jobs/11111111-1111-4111-8111-111111111111/retry' })
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    expect(el.querySelectorAll('.job')).toHaveLength(1);
  });

  it('shows an error when the retry fails and keeps the row', async () => {
    const { fixture, el } = await open();
    el.querySelector<HTMLButtonElement>('.job button.retry')!.click();
    http
      .expectOne({ method: 'POST', url: '/api/admin/jobs/11111111-1111-4111-8111-111111111111/retry' })
      .flush({ statusCode: 409, code: 'not_failed' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('[role=alert]')).not.toBeNull();
    expect(el.querySelectorAll('.job')).toHaveLength(2);
  });

  it('says when there is nothing failed', async () => {
    const { el } = await open([]);
    expect(el.querySelector('.empty')?.textContent).toContain('אין משימות שנכשלו');
  });
});
