import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AccountNav } from './account-nav';
import { CustomerStore } from './customer.store';
import { customerMe, flushCarts, provideAccountTesting, signedIn, tick } from './account.testing';

describe('AccountNav', () => {
  let fixture: ComponentFixture<AccountNav>;
  const el = () => fixture.nativeElement as HTMLElement;

  it('renders nothing (no "התנתקות") until the customer is known', () => {
    provideAccountTesting();
    fixture = TestBed.createComponent(AccountNav);
    fixture.detectChanges();
    expect(el().querySelector('nav')).toBeNull();
    expect(el().textContent).not.toContain('התנתקות');
    signedIn(TestBed.inject(CustomerStore));
    fixture.detectChanges();
    expect(el().querySelector('nav')).not.toBeNull();
    expect(el().textContent).toContain('התנתקות');
  });

  it('signs out and goes home', async () => {
    const http = provideAccountTesting();
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    signedIn(TestBed.inject(CustomerStore), customerMe());
    fixture = TestBed.createComponent(AccountNav);
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('button.sign-out')!.click();
    http.expectOne('/api/account/sign-out').flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    expect(TestBed.inject(CustomerStore).me()).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
    flushCarts(http);
  });

  it('a failed sign-out keeps the customer, stays on the page and shows an alert (no unhandled rejection)', async () => {
    const http = provideAccountTesting();
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    signedIn(TestBed.inject(CustomerStore));
    fixture = TestBed.createComponent(AccountNav);
    fixture.detectChanges();
    el().querySelector<HTMLButtonElement>('button.sign-out')!.click();
    http.expectOne('/api/account/sign-out').flush({}, { status: 500, statusText: 'Error' });
    await tick();
    fixture.detectChanges();
    expect(TestBed.inject(CustomerStore).me()).not.toBeNull();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('לא הצלחנו להתנתק');
  });
});
