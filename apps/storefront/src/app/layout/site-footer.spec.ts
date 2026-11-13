import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { MenuData } from './menu-data';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  it('links to "my order status" (SHP-05)', () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: MenuData, useValue: { rooms: signal([]), categories: signal([]) } }],
    });
    const fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('a[href="/order-status"]');
    expect(link?.textContent?.trim()).toBe('מצב ההזמנה שלי');
  });
});
