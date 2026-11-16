import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { PayDonePage } from './pay-done.page';

describe('PayDonePage', () => {
  function setup(r?: string) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    const fixture = TestBed.createComponent(PayDonePage);
    if (r !== undefined) fixture.componentRef.setInput('r', r);
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, set, fixture };
  }
  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

  it('r=ok: confirms the payment and shows nothing about the order', () => {
    const { el } = setup('ok');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('התשלום התקבל');
    expect(text(el)).toContain('אישור ההזמנה נשלח אליך במייל. אפשר להחזיר את הטאבלט למוכר.');
    expect(el.querySelector('bdi')).toBeNull();
    expect(text(el)).not.toMatch(/\d/);
  });

  it('r=fail: says the payment did not complete and that nothing was charged', () => {
    const { el } = setup('fail');
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('התשלום לא הושלם');
    expect(text(el)).toContain('לא חויבת. אפשר להחזיר את הטאבלט למוכר כדי לנסות שוב.');
    expect(text(el)).not.toContain('התשלום התקבל');
  });

  it('a missing or unknown r gives neutral copy that claims no outcome', () => {
    for (const r of [undefined, 'x']) {
      TestBed.resetTestingModule();
      const { el } = setup(r);
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('סיימת בדף התשלום');
      expect(text(el)).toContain('אפשר להחזיר את הטאבלט למוכר. אם התשלום הצליח, אישור ההזמנה יישלח אליך במייל.');
    }
  });

  it('moves the focus to the heading', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(PayDonePage);
    const el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    fixture.componentRef.setInput('r', 'ok');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(el.querySelector('h1'));
    el.remove();
  });

  it('is noindex', () => {
    const { set } = setup('ok');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/pay/done', noindex: true }));
  });
});
