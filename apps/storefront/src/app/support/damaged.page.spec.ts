import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { PageMeta } from '../core/page-meta';
import { DamagedPage } from './damaged.page';
import { answerLookup, deliveredOrder, failWith, setupSupport, tick } from './support.testing';

describe('DamagedPage (/returns/damaged, SRV-03)', () => {
  let fixture: ComponentFixture<DamagedPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const fill = (selector: string, value: string) => {
    const input = q(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const photo = (name = 'a.jpg', type = 'image/jpeg') => new File(['x'], name, { type });
  const addPhotos = (...files: File[]) => {
    const input = q('input[type="file"]');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  };
  const submitStep = () => {
    q<HTMLFormElement>('hg-support-order-step form').dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  };
  const submitForm = async () => {
    q<HTMLFormElement>('form:not(hg-support-order-step form)').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const alerts = () => [...el().querySelectorAll('.form-error[role="alert"]')].map((a) => a.textContent?.trim());

  async function openOrder(order = deliveredOrder()) {
    http = setupSupport();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    fixture = TestBed.createComponent(DamagedPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('order', '100001');
    fixture.detectChanges();
    await settle();
    fill('#dm-os-phone', '050-123-4567');
    submitStep();
    await answerLookup(http, order);
    await settle();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('is a noindex page "דיווח על מוצר פגום"', async () => {
    http = setupSupport();
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(DamagedPage);
    fixture.detectChanges();
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/returns/damaged', noindex: true }));
    expect(q('h1').textContent?.trim()).toBe('דיווח על מוצר פגום');
  });

  it('offers a labelled line list, description and the photo picker for a delivered order', async () => {
    await openOrder();
    expect(q('label[for="dm-line"]').textContent?.trim()).toBe('איזה פריט פגום?');
    expect([...el().querySelectorAll('#dm-line option')].map((o) => o.textContent?.trim())).toEqual([
      'בחרו פריט',
      'ALBA · ספה תלת מושבית · בז׳',
      'LUNA · שולחן קפה · בז׳',
    ]);
    expect(q('label[for="dm-description"]').textContent?.trim()).toBe('תיאור הנזק');
    expect(q('input[type="file"]').getAttribute('accept')).toBe('image/*');
  });

  it('refuses an empty submit: errors tied to fields, focus on the first, nothing sent', async () => {
    await openOrder();
    await submitForm();
    expect(text()).toContain('יש לבחור פריט מתוך ההזמנה');
    expect(text()).toContain('יש לתאר את הנזק (10–2000 תווים)');
    expect(text()).toContain('יש לצרף 1–5 תמונות');
    expect(q('#dm-line').getAttribute('aria-describedby')).toBe('dm-line-error');
    expect(q('#dm-description').getAttribute('aria-describedby')).toBe('dm-description-error');
    expect(document.activeElement).toBe(q('#dm-line'));
    http.expectNone('/api/support/damaged');
  });

  it('requires at least one photo', async () => {
    await openOrder();
    q<HTMLSelectElement>('#dm-line').value = '12';
    q('#dm-line').dispatchEvent(new Event('change'));
    fill('#dm-description', 'הרגל של השולחן שבורה');
    await submitForm();
    expect(q('#dm-photos-error').textContent).toContain('יש לצרף 1–5 תמונות');
    expect(document.activeElement).toBe(q('#dm-photos'));
  });

  it('sends multipart fields and every photo with the order reference, then confirms with the ticket number', async () => {
    await openOrder();
    q<HTMLSelectElement>('#dm-line').value = '12';
    q('#dm-line').dispatchEvent(new Event('change'));
    fill('#dm-description', '  הרגל של השולחן שבורה  ');
    addPhotos(photo('one.jpg'), photo('two.png', 'image/png'));
    await submitForm();
    const req = http.expectOne('/api/support/damaged');
    const body = req.request.body as FormData;
    expect(body.get('order[number]')).toBe('100001');
    expect(body.get('order[phone]')).toBe('050-123-4567');
    expect(body.get('orderItemId')).toBe('12');
    expect(body.get('description')).toBe('הרגל של השולחן שבורה');
    expect(body.get('website')).toBe('');
    expect(body.getAll('photos').map((f) => (f as File).name)).toEqual(['one.jpg', 'two.png']);
    req.flush({ ticketNumber: 5003 }, { status: 202, statusText: 'Accepted' });
    await settle();
    const success = q<HTMLElement>('#dm-success');
    expect(success.textContent?.trim()).toBe('קיבלנו את פנייתך. מספר הפנייה: 5003');
    expect(document.activeElement).toBe(success);
  });

  it('maps not_delivered to the shared wording and a bad photo to the photos field', async () => {
    await openOrder();
    q<HTMLSelectElement>('#dm-line').value = '11';
    q('#dm-line').dispatchEvent(new Event('change'));
    fill('#dm-description', 'הספה הגיעה קרועה בצד');
    addPhotos(photo());
    await submitForm();
    failWith(http.expectOne('/api/support/damaged'), 409, 'not_delivered');
    await settle();
    expect(alerts()).toContain('אפשר לשלוח בקשה זו רק להזמנה שסופקה');
    await submitForm();
    failWith(http.expectOne('/api/support/damaged'), 400, 'invalid_field', { field: 'photos' });
    await settle();
    expect(q('#dm-photos-error').textContent).toContain('יש לצרף 1–5 תמונות');
    expect(document.activeElement).toBe(q('#dm-photos'));
  });

  it('offers no form for an order that is not delivered', async () => {
    await openOrder(deliveredOrder({}, 'shipped'));
    expect(alerts()).toContain('אפשר לשלוח בקשה זו רק להזמנה שסופקה');
    expect(el().querySelector('#dm-description')).toBeNull();
  });

  it('has a hidden honeypot named website, out of the tab order and hidden from screen readers', async () => {
    await openOrder();
    const trap = q('#dm-website');
    expect(trap.getAttribute('name')).toBe('website');
    expect(trap.getAttribute('tabindex')).toBe('-1');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('two lines of the same model differ by their options in the line list', async () => {
    const base = deliveredOrder();
    await openOrder(
      deliveredOrder({
        lines: [
          { ...base.lines[0], orderItemId: 11, optionLabels: ['אפור', 'שמאל'] },
          { ...base.lines[0], orderItemId: 13, optionLabels: ['אפור', 'ימין'] },
        ],
      }),
    );
    expect([...el().querySelectorAll('#dm-line option')].slice(1).map((o) => o.textContent?.trim())).toEqual([
      'ALBA · ספה תלת מושבית · אפור · שמאל',
      'ALBA · ספה תלת מושבית · אפור · ימין',
    ]);
  });

  it('the intro asks for the phone only when signed out', async () => {
    http = setupSupport();
    fixture = TestBed.createComponent(DamagedPage);
    fixture.detectChanges();
    await settle();
    expect(q('.intro').textContent?.trim()).toBe('הזינו את מספר ההזמנה ואת הטלפון שאיתו הזמנתם, וצרפו תמונות של הנזק.');
    fixture.destroy();
    TestBed.resetTestingModule();
    http = setupSupport(true);
    fixture = TestBed.createComponent(DamagedPage);
    fixture.detectChanges();
    await settle();
    expect(q('.intro').textContent?.trim()).toBe('הזינו את מספר ההזמנה וצרפו תמונות של הנזק.');
  });
});
