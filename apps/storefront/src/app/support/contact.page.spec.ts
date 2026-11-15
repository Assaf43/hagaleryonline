import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { PageMeta } from '../core/page-meta';
import { SUPPORT_CONTACT } from '../core/support-contact';
import { ContactPage } from './contact.page';
import { failWith, setupSupport, tick } from './support.testing';

describe('ContactPage (/contact, SRV-05)', () => {
  let fixture: ComponentFixture<ContactPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const fill = (id: string, value: string) => {
    const input = q(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const submit = async () => {
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const fillAll = () => {
    fill('ct-fullName', 'דנה כהן');
    fill('ct-phone', '050-123-4567');
    fill('ct-email', 'dana@example.com');
    fill('ct-subject', 'שאלה על משלוח');
    fill('ct-message', 'מתי תגיע הספה שהזמנתי?');
  };

  async function open(signedIn = false) {
    http = setupSupport(signedIn);
    fixture = TestBed.createComponent(ContactPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await settle();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('is a noindex page with the phone and a WhatsApp button to wa.me', async () => {
    http = setupSupport();
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(ContactPage);
    fixture.detectChanges();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/contact', noindex: true }));
    expect(q('h1').textContent?.trim()).toBe('צור קשר');
    expect(q<HTMLAnchorElement>('a[href^="tel:"]').getAttribute('href')).toBe(`tel:${SUPPORT_CONTACT.phone}`);
    const wa = q<HTMLAnchorElement>('a[href^="https://wa.me/"]');
    expect(wa.getAttribute('href')).toBe(`https://wa.me/${SUPPORT_CONTACT.whatsapp}`);
    expect(wa.textContent?.trim()).toBe('שליחת הודעה בוואטסאפ');
  });

  it('labels every field and the optional order number', async () => {
    await open();
    const labels = [...el().querySelectorAll('form label.field-label')].map((l) => l.textContent?.trim());
    expect(labels).toEqual(['שם מלא', 'טלפון נייד', 'דוא״ל', 'נושא', 'הודעה', 'מספר הזמנה (לא חובה)']);
    for (const label of el().querySelectorAll<HTMLLabelElement>('form label.field-label')) {
      expect(q(`#${label.htmlFor}`)).not.toBeNull();
    }
  });

  it('refuses an empty submit with an error per field tied by aria-describedby, focusing the first', async () => {
    await open();
    await submit();
    for (const f of ['fullName', 'phone', 'email', 'subject', 'message']) {
      expect(q(`#ct-${f}`).getAttribute('aria-invalid')).toBe('true');
      expect(q(`#ct-${f}`).getAttribute('aria-describedby')).toBe(`ct-${f}-error`);
      expect(q(`#ct-${f}-error`).textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(q('#ct-phone-error').textContent).toContain('יש להזין מספר טלפון נייד תקין');
    expect(document.activeElement).toBe(q('#ct-fullName'));
    http.expectNone('/api/support/contact');
  });

  it('clears a field error as the customer types', async () => {
    await open();
    await submit();
    fill('ct-fullName', 'דנה כהן');
    expect(el().querySelector('#ct-fullName-error')).toBeNull();
  });

  it('sends the trimmed form with a normalized phone, and an optional order number only when typed', async () => {
    await open();
    fillAll();
    fill('ct-orderNumber', ' 100001 ');
    await submit();
    const req = http.expectOne('/api/support/contact');
    expect(req.request.body).toEqual({
      fullName: 'דנה כהן',
      phone: '0501234567',
      email: 'dana@example.com',
      subject: 'שאלה על משלוח',
      message: 'מתי תגיע הספה שהזמנתי?',
      website: '',
      orderNumber: '100001',
    });
    req.flush({ ticketNumber: 5004 }, { status: 202, statusText: 'Accepted' });
    await settle();
    const success = q<HTMLElement>('#ct-success');
    expect(success.textContent?.trim()).toBe('קיבלנו את פנייתך. מספר הפנייה: 5004');
    expect(document.activeElement).toBe(success);
    expect(el().querySelector('form')).toBeNull();
  });

  it('omits the order number when empty', async () => {
    await open();
    fillAll();
    await submit();
    const req = http.expectOne('/api/support/contact');
    expect('orderNumber' in req.request.body).toBe(false);
    req.flush({}, { status: 202, statusText: 'Accepted' });
    await settle();
  });

  it('rejects a non-numeric order number', async () => {
    await open();
    fillAll();
    fill('ct-orderNumber', 'abc');
    await submit();
    expect(q('#ct-orderNumber-error').textContent).toContain('מספר ההזמנה אינו תקין');
    http.expectNone('/api/support/contact');
  });

  it('shows a server field error beside its field, and a throttle as a general alert', async () => {
    await open();
    fillAll();
    await submit();
    failWith(http.expectOne('/api/support/contact'), 400, 'invalid_field', { field: 'email' });
    await settle();
    expect(q('#ct-email-error').textContent).toContain('כתובת דוא״ל תקינה');
    expect(document.activeElement).toBe(q('#ct-email'));
    await submit();
    failWith(http.expectOne('/api/support/contact'), 429, 'too_many_requests');
    await settle();
    expect(q('.form-error[role="alert"]').textContent).toContain('יותר מדי ניסיונות');
  });

  it('prefills the details of a signed-in customer', async () => {
    await open(true);
    expect(q('#ct-fullName').value).toBe('דנה כהן');
    expect(q('#ct-phone').value).toBe('0501234567');
    expect(q('#ct-email').value).toBe('dana@example.com');
  });

  it('has a hidden honeypot named website, out of the tab order and hidden from screen readers', async () => {
    await open();
    const trap = q('#ct-website');
    expect(trap.getAttribute('name')).toBe('website');
    expect(trap.getAttribute('tabindex')).toBe('-1');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
