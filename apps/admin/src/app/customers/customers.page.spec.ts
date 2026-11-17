import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { CustomerPage } from '@hg/models';
import { CustomersPage } from './customers.page';

const PAGE: CustomerPage = {
  items: [
    {
      id: '6f9a1c2e-0000-4000-8000-000000000001',
      fullName: 'דנה כהן',
      phone: '0501234567',
      email: 'dana@example.test',
      createdVia: 'web',
      createdAt: '2026-11-05T22:30:00.000Z',
      orderCount: 2,
    },
    {
      id: '6f9a1c2e-0000-4000-8000-000000000002',
      fullName: 'רון לוי',
      phone: '0527654321',
      email: null,
      createdVia: 'store',
      createdAt: '2026-11-04T10:00:00.000Z',
      orderCount: 0,
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

describe('admin customers list ("לקוחות")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(query: { q?: string; page?: string } = {}, page: CustomerPage = PAGE) {
    const fixture = TestBed.createComponent(CustomersPage);
    if (query.q !== undefined) fixture.componentRef.setInput('q', query.q);
    if (query.page !== undefined) fixture.componentRef.setInput('page', query.page);
    fixture.detectChanges();
    http
      .expectOne(
        (r) =>
          r.url === '/api/admin/customers' &&
          r.params.get('q') === (query.q || null) &&
          r.params.get('page') === (query.page ?? '1'),
      )
      .flush(page);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the customers with how they were created, their order count and a link to the profile', async () => {
    const { el } = await open();
    const rows = [...el.querySelectorAll('.customer')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/customers/6f9a1c2e-0000-4000-8000-000000000001');
    expect(rows[0].textContent).toContain('דנה כהן');
    expect(rows[0].querySelector('.phone')?.textContent).toBe('0501234567');
    expect(rows[0].querySelector('.email')?.textContent).toBe('dana@example.test');
    expect(rows[0].querySelector('.origin')?.textContent?.trim()).toBe('אתר');
    // 22:30 UTC is already the next day in Israel, whatever the machine's own time zone.
    expect(rows[0].querySelector('.date')?.textContent).toContain('6.11.2026 00:30');
    expect(rows[0].querySelector('.orders-count bdi')?.textContent).toBe('2');
    expect(rows[1].querySelector('.origin')?.textContent?.trim()).toBe('חנות');
    expect(rows[1].querySelector('.email')).toBeNull();
  });

  it('searches by name, phone, e-mail or order number and keeps the text in the URL', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { fixture, el } = await open();
    const field = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(el.querySelector(`label[for="${field.id}"]`)?.textContent).toContain('חיפוש');
    field.value = ' 050-123 ';
    field.dispatchEvent(new Event('input'));
    el.querySelector<HTMLFormElement>('form.search')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { q: '050-123', page: null },
    });

    // The route binds the query: the page loads what it says and shows it in the field.
    fixture.componentRef.setInput('q', '050-123');
    fixture.detectChanges();
    http
      .expectOne((r) => r.params.get('q') === '050-123' && r.params.get('page') === '1')
      .flush({
        ...PAGE,
        items: [],
        total: 0,
      });
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('050-123');
    expect(el.querySelector('.empty')?.textContent).toContain('לא נמצאו לקוחות');
  });

  it('pages the list', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const { el } = await open({ q: 'דנה' }, { ...PAGE, total: 70 });
    expect([...el.querySelectorAll('.pager bdi')].map((b) => b.textContent)).toEqual(['1', '3']);
    el.querySelectorAll<HTMLButtonElement>('.pager button')[1].click();
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { q: 'דנה', page: 2 },
    });
  });

  it('shows a Hebrew error with a retry when the list cannot be loaded', async () => {
    const fixture = TestBed.createComponent(CustomersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/customers?page=1').flush({}, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role=alert]')?.textContent).toContain('משהו השתבש');
    el.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    http.expectOne('/api/admin/customers?page=1').flush(PAGE);
    await settle(fixture);
    expect(el.querySelectorAll('.customer')).toHaveLength(2);
  });
});
