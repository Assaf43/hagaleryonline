import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { AdminSentMessage } from '@hg/models';
import { SentMessagesApi } from '../core/sent-messages.api';
import { SentMessagesPage } from './sent-messages.page';

const MESSAGES: AdminSentMessage[] = [
  {
    id: 'm2',
    channel: 'sms',
    recipientMasked: '050-***-1234',
    template: 'otp',
    provider: 'mock',
    status: 'sent',
    orderNumber: null,
    createdAt: '2026-11-12T10:30:00.000Z',
    subject: null,
    body: 'קוד האימות שלך: 123456. תקף ל־10 דקות.',
  },
  {
    id: 'm1',
    channel: 'email',
    recipientMasked: 'd***@example.test',
    template: 'order_paid',
    provider: 'mock',
    status: 'sent',
    orderNumber: 100123,
    createdAt: '2026-11-12T10:00:00.000Z',
    subject: 'ההזמנה 100123 התקבלה',
    body: '<html dir="rtl"><body><script>alert(1)</script><p>שלום</p></body></html>',
  },
];

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('SentMessagesPage ("הודעות שנשלחו (בדיקה)")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(SentMessagesPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/dev/messages').flush(MESSAGES);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows an SMS as text, and an e-mail in a sandboxed iframe', async () => {
    const { fixture, el } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('הודעות שנשלחו (בדיקה)');
    expect(el.querySelectorAll('.message')).toHaveLength(2);
    // The newest (first) is selected: an SMS with its code, no iframe.
    expect(el.querySelector('.sms')?.textContent).toContain('123456');
    expect(el.querySelector('iframe')).toBeNull();

    el.querySelectorAll<HTMLButtonElement>('.message')[1].click();
    await settle(fixture);
    const frame = el.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toContain('dir="rtl"');
    expect(el.querySelector('.sms')).toBeNull();
  });
});

describe('SentMessagesApi.probe', () => {
  let http: HttpTestingController;
  let api: SentMessagesApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(SentMessagesApi);
  });

  afterEach(() => http.verify());

  it('is available only when the endpoint answers 200', async () => {
    const ok = api.probe();
    http.expectOne('/api/admin/dev/messages').flush([]);
    await ok;
    expect(api.available()).toBe(true);

    const missing = api.probe();
    http.expectOne('/api/admin/dev/messages').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await missing;
    expect(api.available()).toBe(false);
  });
});
