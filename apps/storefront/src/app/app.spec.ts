import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
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
    expect(el.querySelector('.logo')?.textContent).toContain('הגלריה לכולם');
    expect(el.querySelector('hg-theme-toggle button')).toBeTruthy();
    expect(el.querySelector('a[href="/room/living-room"]')?.textContent).toContain('סלון');
    expect(el.querySelector('.nav-desktop a[href="/category/sofas"]')?.textContent).toContain('ספות');
    expect(el.querySelector('main#main')).toBeTruthy();
    http.verify();
  });
});
