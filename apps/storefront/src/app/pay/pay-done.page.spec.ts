import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { PayDonePage } from './pay-done.page';

describe('PayDonePage', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    const fixture = TestBed.createComponent(PayDonePage);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, set };
  }

  it('shows the confirmation copy and nothing about the order', () => {
    const { el } = setup();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('התשלום התקבל');
    const text = el.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('אישור ההזמנה נשלח אליך במייל. אפשר להחזיר את הטאבלט למוכר.');
    expect(el.querySelector('bdi')).toBeNull();
    expect(text).not.toMatch(/\d/);
  });

  it('is noindex', () => {
    const { set } = setup();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/pay/done', noindex: true }));
  });
});
