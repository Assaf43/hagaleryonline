import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SUPPORT_TICKET_STATUS_LABELS_HE, SUPPORT_TICKET_TYPE_LABELS_HE, type AdminTicketPage } from '@hg/models';
import { InboxPage } from './inbox.page';
import { NewCountBadge } from './new-count-badge';

const PAGE: AdminTicketPage = {
  items: [
    {
      number: 5002,
      type: 'damaged',
      status: 'new',
      // 22:30 UTC is already the next day in Israel: the list shows Israel time on any machine.
      createdAt: '2026-11-05T22:30:00.000Z',
      fullName: 'דנה כהן',
      phone: '0501234567',
      subject: null,
      orderNumber: 100002,
      attachmentCount: 3,
    },
    {
      number: 5001,
      type: 'contact',
      status: 'closed',
      createdAt: '2026-11-04T10:00:00.000Z',
      fullName: 'רון לוי',
      phone: '0527654321',
      subject: 'שאלה על משלוח',
      orderNumber: null,
      attachmentCount: 0,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 30,
};

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('support inbox ("פניות")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the tickets with Hebrew type and status, Israel-time date, and links to the ticket page', async () => {
    const fixture = TestBed.createComponent(InboxPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/support?page=1').flush(PAGE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.ticket')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.type')?.textContent?.trim()).toBe('מוצר פגום');
    expect(rows[0].querySelector('.status')?.textContent?.trim()).toBe('חדשה');
    expect(rows[0].querySelector('.date')?.textContent).toContain('6.11.2026 00:30');
    expect(rows[0].textContent).toContain('דנה כהן');
    expect(rows[0].textContent).toContain('100002');
    expect(rows[0].querySelector('.photos')?.textContent).toContain('3 תמונות');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/support/5002');
    expect(rows[1].querySelector('.status')?.textContent?.trim()).toBe('סגורה');
    expect(rows[1].textContent).toContain('שאלה על משלוח');
    expect(rows[1].querySelector('.photos')).toBeNull();
  });

  it('offers a type filter and a status filter for every value, and puts the choice in the URL', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(InboxPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/support?page=1').flush({ ...PAGE, total: 70 });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const labels = (group: string) =>
      [...el.querySelectorAll(`[data-filter="${group}"] .filter`)].map((b) => b.textContent?.trim());
    expect(labels('type')).toEqual(['הכול', ...Object.values(SUPPORT_TICKET_TYPE_LABELS_HE)]);
    expect(labels('status')).toEqual(['הכול', ...Object.values(SUPPORT_TICKET_STATUS_LABELS_HE)]);

    const click = (group: string, text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>(`[data-filter="${group}"] .filter`)]
        .find((b) => b.textContent?.trim() === text)!
        .click();
    click('type', 'החזרה');
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { type: 'return', status: null, page: null },
    });
    click('status', 'בטיפול');
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { type: null, status: 'in_progress', page: null },
    });
    el.querySelectorAll<HTMLButtonElement>('.pager button')[1].click();
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { type: null, status: null, page: 2 },
    });

    // The route binds the query parameters: the page loads what they say and marks the pressed filters.
    fixture.componentRef.setInput('type', 'return');
    fixture.componentRef.setInput('status', 'in_progress');
    fixture.componentRef.setInput('page', '2');
    fixture.detectChanges();
    http
      .expectOne(
        (r) =>
          r.url === '/api/admin/support' &&
          r.params.get('type') === 'return' &&
          r.params.get('status') === 'in_progress' &&
          r.params.get('page') === '2',
      )
      .flush({ ...PAGE, items: [], total: 0 });
    await settle(fixture);
    const pressed = [...el.querySelectorAll('.filter[aria-pressed="true"]')].map((b) => b.textContent?.trim());
    expect(pressed).toEqual(['החזרה', 'בטיפול']);
    expect(el.querySelector('.empty')?.textContent).toContain('אין פניות');
  });

  it('ignores unknown filter values in the URL', async () => {
    const fixture = TestBed.createComponent(InboxPage);
    fixture.componentRef.setInput('type', 'refund');
    fixture.componentRef.setInput('status', 'open');
    fixture.detectChanges();
    http.expectOne('/api/admin/support?page=1').flush(PAGE);
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.ticket')).toHaveLength(2);
  });
});

@Component({ imports: [NewCountBadge], template: '<hga-new-count-badge />' })
class BadgeHost {}

@Component({ template: '' })
class Blank {}

describe('new tickets badge', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'orders', component: Blank }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shows the count of new tickets with a spoken label, and refreshes it on every navigation', async () => {
    const fixture = TestBed.createComponent(BadgeHost);
    fixture.detectChanges();
    http.expectOne('/api/admin/support/count-new').flush({ count: 4 });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('4');
    expect(el.querySelector('.visually-hidden')?.textContent).toContain('4 פניות חדשות');

    await TestBed.inject(Router).navigateByUrl('/orders');
    http.expectOne('/api/admin/support/count-new').flush({ count: 0 });
    await settle(fixture);
    expect(el.querySelector('.count')).toBeNull();
  });

  it('shows nothing when the count cannot be loaded', async () => {
    const fixture = TestBed.createComponent(BadgeHost);
    fixture.detectChanges();
    http
      .expectOne('/api/admin/support/count-new')
      .flush({ code: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('.count')).toBeNull();
  });
});
