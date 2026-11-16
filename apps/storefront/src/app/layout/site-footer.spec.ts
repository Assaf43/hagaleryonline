import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { MenuData } from './menu-data';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  it('links to "my order status" (SHP-05)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideRouter([]),
        { provide: MenuData, useValue: { rooms: signal([]), categories: signal([]) } },
      ],
    });
    const fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/order-status"]');
    expect(link?.textContent?.trim()).toBe('מצב ההזמנה שלי');
  });

  it('links to the returns and contact pages (SRV-02, SRV-05)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideRouter([]),
        { provide: MenuData, useValue: { rooms: signal([]), categories: signal([]) } },
      ],
    });
    const fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('a[href="/returns"]')?.textContent?.trim()).toBe('החזרות והחלפות');
    expect(root.querySelector('a[href="/contact"]')?.textContent?.trim()).toBe('צור קשר');
  });

  it('has the newsletter sign-up form (MKT-01)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideRouter([]),
        { provide: MenuData, useValue: { rooms: signal([]), categories: signal([]) } },
      ],
    });
    const fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('hg-newsletter-form input[type="email"]'),
    ).not.toBeNull();
  });
});
