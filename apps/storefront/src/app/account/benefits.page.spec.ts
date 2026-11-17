import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import type { AccountBenefit } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { BenefitsPage } from './benefits.page';
import { customerMe, provideAccountTesting, signedIn, tick } from './account.testing';

const benefit = (over: Partial<AccountBenefit> = {}): AccountBenefit => ({
  code: 'NST-AB23CD45',
  labelHe: 'הטבת הצטרפות',
  discountKind: 'percent',
  discountValue: 10,
  minSubtotal: null,
  expiresAt: '2026-12-17T10:00:00.000Z',
  status: 'active',
  ...over,
});

describe('BenefitsPage', () => {
  let fixture: ComponentFixture<BenefitsPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const rows = () => Array.from(el().querySelectorAll('li.benefit'));

  async function setup(answer: AccountBenefit[] | 'error') {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), customerMe());
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(BenefitsPage);
    fixture.detectChanges();
    const req = http.expectOne('/api/account/benefits');
    if (answer === 'error') req.flush({}, { status: 500, statusText: 'Error' });
    else req.flush(answer);
    await tick();
    fixture.detectChanges();
    return set;
  }

  afterEach(() => http.verify());

  it('is noindex and lists a code with its value, expiry and status', async () => {
    const set = await setup([benefit()]);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true, path: '/account/benefits' }));
    expect(text()).toContain('הטבת הצטרפות');
    expect(text()).toContain('NST-AB23CD45');
    expect(text()).toContain('10% הנחה');
    expect(text()).toContain('בתוקף עד 17.12.2026');
    expect(rows()[0].querySelector('bdi')).not.toBeNull();
  });

  it('shows a fixed amount in shekels with the minimum purchase', async () => {
    await setup([benefit({ discountKind: 'fixed', discountValue: 15000, minSubtotal: 200000 })]);
    expect(text()).toContain('150 ₪ הנחה');
    expect(text()).toContain('בקנייה מעל 2,000 ₪');
  });

  it('puts active codes first and marks used and expired ones', async () => {
    await setup([
      benefit({ code: 'NST-USED0001', status: 'used' }),
      benefit({ code: 'NST-GONE0002', status: 'expired' }),
      benefit({ code: 'NST-LIVE0003', status: 'active' }),
    ]);
    const codes = rows().map((r) => r.querySelector('.code')?.textContent?.trim());
    expect(codes).toEqual(['NST-LIVE0003', 'NST-USED0001', 'NST-GONE0002']);
    expect(rows()[1].textContent).toContain('נוצל');
    expect(rows()[2].textContent).toContain('פג תוקף');
    expect(rows()[0].textContent).toContain('זמין');
  });

  it('shows an empty state', async () => {
    await setup([]);
    expect(rows().length).toBe(0);
    expect(text()).toContain('אין הטבות בחשבון כרגע');
  });

  it('shows a retry on a failed load', async () => {
    await setup('error');
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    http.expectOne('/api/account/benefits').flush([]);
    await tick();
    fixture.detectChanges();
    expect(text()).toContain('אין הטבות בחשבון כרגע');
  });
});
