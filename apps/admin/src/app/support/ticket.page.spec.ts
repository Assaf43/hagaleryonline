import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminMe, AdminTicketDetail, Permission } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { TicketPage } from './ticket.page';

const TICKET: AdminTicketDetail = {
  number: 5003,
  type: 'damaged',
  status: 'new',
  createdAt: '2026-11-05T22:30:00.000Z',
  updatedAt: '2026-11-05T22:30:00.000Z',
  contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.test' },
  subject: null,
  message: 'הרגל של הספה נשברה בהובלה',
  reasonCode: null,
  orderNumber: 100002,
  hasAccount: true,
  items: [
    {
      orderItemId: 7,
      quantity: null,
      sku: 'ALBA-BEIGE',
      modelName: 'ALBA',
      nameHe: 'ספה תלת־מושבית',
      optionLabels: ['בז׳'],
      orderedQuantity: 1,
    },
  ],
  attachments: [
    { id: 11, mimeType: 'image/webp', size: 1000 },
    { id: 12, mimeType: 'image/webp', size: 2000 },
  ],
  notes: [{ id: 1, body: 'התקשרתי ללקוחה', createdAt: '2026-11-06T08:15:00.000Z', author: { id: 2, name: 'מיכל' } }],
};

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('support ticket page', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(
    ticket: AdminTicketDetail = TICKET,
    permissions: Permission[] = ['support.manage', 'orders.view'],
  ) {
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'can').mockImplementation((p) => permissions.includes(p));
    vi.spyOn(auth, 'me').mockReturnValue({ id: 2, name: 'מיכל', permissions } as unknown as AdminMe);
    const fixture = TestBed.createComponent(TicketPage);
    fixture.componentRef.setInput('number', String(ticket.number));
    fixture.detectChanges();
    http.expectOne(`/api/admin/support/${ticket.number}`).flush(ticket);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows type and status chips, contact, the order link, the lines and the notes with author and time', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('5003');
    expect(el.querySelector('.type')?.textContent?.trim()).toBe('מוצר פגום');
    expect(el.querySelector('.status')?.textContent?.trim()).toBe('חדשה');
    expect(el.querySelector('.contact')?.textContent).toContain('dana@example.test');
    expect(el.querySelector('.contact')?.textContent).toContain('0501234567');
    const orderLink = el.querySelector<HTMLAnchorElement>('a.order-link')!;
    expect(orderLink.getAttribute('href')).toBe('/orders/100002');
    expect(el.textContent).toContain('הרגל של הספה נשברה בהובלה');
    expect(el.querySelector('.line')?.textContent).toContain('ALBA');
    expect(el.querySelector('.line')?.textContent).toContain('ALBA-BEIGE');
    const note = el.querySelector('.note')!;
    expect(note.textContent).toContain('התקשרתי ללקוחה');
    expect(note.textContent).toContain('מיכל');
    // 08:15 UTC is 10:15 in Israel (winter), on any machine.
    expect(note.textContent).toContain('6.11.2026 10:15');
  });

  it('renders the photos from the private admin endpoint, with alt text and a full-size link', async () => {
    const { el } = await open();
    const photos = [...el.querySelectorAll<HTMLAnchorElement>('.photos a')];
    expect(photos).toHaveLength(2);
    expect(photos[0].getAttribute('href')).toBe('/api/admin/support/5003/attachments/11');
    expect(photos[0].getAttribute('target')).toBe('_blank');
    const img = photos[1].querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/admin/support/5003/attachments/12');
    expect(img.getAttribute('alt')).toBe('תמונה 2 מתוך 2 שצירף הלקוח');
    expect(photos[1].getAttribute('aria-label')).toContain('בגודל מלא');
  });

  it('adds a note and shows the answer; an empty note is not sent', async () => {
    const { fixture, el } = await open();
    const textarea = el.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!;
    expect(el.querySelector(`label[for="${textarea.id}"]`)).not.toBeNull();
    const submit = async () => {
      el.querySelector<HTMLFormElement>('form.note-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
    };
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    await submit();
    expect(el.querySelector('.note-form [role=alert]')?.textContent).toContain('יש לכתוב הערה');

    textarea.value = '  חזרתי אליה, נשלח טכנאי  ';
    textarea.dispatchEvent(new Event('input'));
    await settle(fixture);
    await submit();
    const req = http.expectOne('/api/admin/support/5003/notes');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ body: 'חזרתי אליה, נשלח טכנאי' });
    req.flush({
      ...TICKET,
      notes: [
        ...TICKET.notes,
        {
          id: 2,
          body: 'חזרתי אליה, נשלח טכנאי',
          createdAt: '2026-11-06T09:00:00.000Z',
          author: { id: 2, name: 'מיכל' },
        },
      ],
    });
    await settle(fixture);
    expect(el.querySelectorAll('.note')).toHaveLength(2);
    expect(el.querySelectorAll('.note')[1].textContent).toContain('נשלח טכנאי');
    expect(el.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!.value).toBe('');
  });

  it('the select only holds a choice: arrow-key changes post nothing; "עדכון סטטוס" posts once and refreshes the badge', async () => {
    const { fixture, el } = await open();
    const select = el.querySelector<HTMLSelectElement>('select[name="status"]')!;
    const button = el.querySelector<HTMLButtonElement>('button.apply-status')!;
    expect(el.querySelector(`label[for="${select.id}"]`)?.textContent).toContain('סטטוס');
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual(['חדשה', 'בטיפול', 'סגורה']);
    expect(button.textContent?.trim()).toBe('עדכון סטטוס');
    // Unchanged choice: the button is unavailable (but stays focusable) and a click sends nothing.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    await settle(fixture);
    http.expectNone('/api/admin/support/5003/status');

    // Arrow keys on a closed select fire "change" per step: new → in_progress → closed, nothing sent.
    for (const value of ['in_progress', 'closed']) {
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await settle(fixture);
    }
    http.expectNone('/api/admin/support/5003/status');
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    expect(select.disabled).toBe(false);

    button.focus();
    button.click();
    button.click(); // A second click while saving is ignored.
    await settle(fixture);
    const req = http.expectOne('/api/admin/support/5003/status');
    expect(req.request.body).toEqual({ status: 'closed' });
    expect(select.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    req.flush({ ...TICKET, status: 'closed' });
    await settle(fixture);
    http.expectOne('/api/admin/support/count-new').flush({ count: 0 });
    await settle(fixture);
    expect(el.querySelector('.head .status')?.textContent?.trim()).toBe('סגורה');
    expect(el.querySelector('.status-row [role=status]')?.textContent).toContain('הסטטוס עודכן: סגורה');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
  });

  it('a refused status change shows the error and keeps the choice for another try', async () => {
    const { fixture, el } = await open();
    const select = el.querySelector<HTMLSelectElement>('select[name="status"]')!;
    select.value = 'in_progress';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button.apply-status')!.click();
    http
      .expectOne('/api/admin/support/5003/status')
      .flush({ code: 'invalid_input', field: 'status' }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.querySelector('.status-row [role=alert]')?.textContent).toContain('הסטטוס לא תקין');
    expect(el.querySelector('.head .status')?.textContent?.trim()).toBe('חדשה');
    expect(el.querySelector<HTMLButtonElement>('button.apply-status')!.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a contact ticket says its order number was typed by the sender; without orders.view the number is text', async () => {
    const { el } = await open(
      { ...TICKET, type: 'contact', subject: 'שאלה', attachments: [], items: [], hasAccount: false },
      ['support.manage'],
    );
    expect(el.querySelector('a.order-link')).toBeNull();
    expect(el.querySelector('.order')?.textContent).toContain('100002');
    expect(el.querySelector('.order')?.textContent).toContain('לא אומת');
    expect(el.querySelector('.photos')).toBeNull();
  });

  it('shows a Hebrew message for an unknown ticket', async () => {
    const fixture = TestBed.createComponent(TicketPage);
    fixture.componentRef.setInput('number', '99999');
    fixture.detectChanges();
    http.expectOne('/api/admin/support/99999').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain(
      'הפנייה לא נמצאה',
    );
  });
});
