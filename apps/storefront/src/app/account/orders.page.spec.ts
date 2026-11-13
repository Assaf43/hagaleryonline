import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import type { AccountOrdersPage } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { OrdersPage } from './orders.page';
import { provideAccountTesting, signedIn, tick } from './account.testing';

const page = (over: Partial<AccountOrdersPage> = {}): AccountOrdersPage => ({
  items: [
    {
      number: 100002,
      status: 'shipped',
      statusLabelHe: 'במשלוח',
      createdAt: '2026-11-11T10:00:00.000Z',
      total: 345000,
      itemCount: 2,
    },
    {
      number: 100001,
      status: 'paid',
      statusLabelHe: 'שולמה',
      createdAt: '2026-11-10T10:00:00.000Z',
      total: 100000,
      itemCount: 1,
    },
  ],
  page: 1,
  pageSize: 10,
  total: 2,
  ...over,
});

describe('OrdersPage', () => {
  let fixture: ComponentFixture<OrdersPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(first: AccountOrdersPage | 'error') {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    await tick();
    const req = http.expectOne((r) => r.url === '/api/account/orders');
    expect(req.request.params.get('page')).toBe('1');
    if (first === 'error') req.flush({}, { status: 500, statusText: 'Error' });
    else req.flush(first);
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex and lists orders with number, status, date, total and a link to the order', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    await tick();
    http.expectOne((r) => r.url === '/api/account/orders').flush(page());
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    const rows = el().querySelectorAll('li.order-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('100002');
    expect(rows[0].textContent).toContain('במשלוח');
    expect(rows[0].textContent).toContain('3,450');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/account/orders/100002');
    expect(rows[0].querySelectorAll('bdi').length).toBeGreaterThanOrEqual(1);
  });

  it('shows an empty state', async () => {
    await setup(page({ items: [], total: 0 }));
    expect(text()).toContain('עדיין אין הזמנות בחשבון');
  });

  it('pages: next loads page 2', async () => {
    await setup(page({ total: 14 }));
    const next = [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('הבא'))!;
    next.click();
    await tick();
    const req = http.expectOne((r) => r.url === '/api/account/orders');
    expect(req.request.params.get('page')).toBe('2');
    req.flush(page({ page: 2, total: 14 }));
    await settle();
    expect(text()).toContain('עמוד 2 מתוך 2');
  });

  it('a load error offers a retry', async () => {
    await setup('error');
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    await tick();
    http.expectOne((r) => r.url === '/api/account/orders').flush(page());
    await settle();
    expect(el().querySelectorAll('li.order-row')).toHaveLength(2);
  });
});
