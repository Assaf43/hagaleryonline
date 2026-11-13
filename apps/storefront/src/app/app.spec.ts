import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { BRAND } from '@hg/models';
import type { CategoryNode, RoomMenuItem } from '@hg/models';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
  });

  it('renders the header with the wordmark, theme switch and a menu built from the API', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    const rooms: RoomMenuItem[] = [
      { slug: 'living-room', nameHe: 'סלון', categories: [{ slug: 'sofas', nameHe: 'ספות' }] },
    ];
    const categories: CategoryNode[] = [{ slug: 'sofas', nameHe: 'ספות', children: [] }];
    http.expectOne('/api/rooms').flush(rooms);
    http.expectOne('/api/categories').flush(categories);
    await fixture.whenStable();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.logo')?.textContent).toContain(BRAND.name);
    expect(el.querySelector('hg-theme-toggle button')).toBeTruthy();
    expect(el.querySelector('a[href="/room/living-room"]')?.textContent).toContain('סלון');
    expect(el.querySelector('.nav-desktop a[href="/category/sofas"]')?.textContent).toContain('ספות');
    expect(el.querySelector('main#main')).toBeTruthy();
    // The header reads the cart once it has rendered in the browser (CRT-01).
    http.expectOne('/api/cart').flush({ lines: [], itemCount: 0, subtotal: 0, notices: [] });
    // ... and the customer session, for the account icon (ACC-01).
    http.expectOne('/api/account/me').flush(null);
    http.verify();
  });

  it('shows the favorites count in the header only after rendering in the browser (CMP-01)', async () => {
    localStorage.setItem('hg.favorites', '[4,2]');
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/rooms').flush([]);
    http.expectOne('/api/categories').flush([]);
    await fixture.whenStable();
    fixture.detectChanges();

    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href="/favorites"]')!;
    expect(link.getAttribute('aria-label')).toBe('המועדפים שלי (2)');
    expect(link.querySelector('.count')?.textContent?.trim()).toBe('2');
    localStorage.clear();
  });
});
