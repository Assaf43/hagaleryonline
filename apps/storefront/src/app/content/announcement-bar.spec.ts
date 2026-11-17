import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { AnnouncementBar } from './announcement-bar';
import { SiteContentStore } from './site-content.store';

describe('AnnouncementBar', () => {
  afterEach(() => {
    document.cookie = 'hg-ann=; Max-Age=0; Path=/';
  });

  it('shows the message and link, and the close button hides it', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(SiteContentStore).site.set({
      supportPhone: '',
      supportEmail: '',
      whatsapp: '',
      shippingHtml: '',
      footerPages: [],
      announcement: { id: 1, version: 1, textHe: 'משלוח חינם', linkUrl: '/info/shipping', linkLabelHe: 'לפרטים' },
    });
    const fixture = TestBed.createComponent(AnnouncementBar);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('משלוח חינם');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/info/shipping');
    const close = el.querySelector<HTMLButtonElement>('button')!;
    expect(close.getAttribute('aria-label')).toBe('סגירת ההודעה');
    close.click();
    fixture.detectChanges();
    expect(el.querySelector('.bar')).toBeNull();
  });
});
