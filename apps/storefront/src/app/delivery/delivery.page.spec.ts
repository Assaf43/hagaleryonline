import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { DeliveryLinkView } from '@hg/models';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { DeliveryPage } from './delivery.page';

const view = (state: DeliveryLinkView['state'] = 'proposed'): DeliveryLinkView => ({
  orderNumber: 100001,
  date: '2026-12-09',
  windowFrom: '09:00',
  windowTo: '13:00',
  state,
});
const URL = '/api/delivery/tok';

describe('DeliveryPage', () => {
  let fixture: ComponentFixture<DeliveryPage>;
  let http: HttpTestingController;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))!;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function setup(first: DeliveryLinkView | 404 | 500) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(DeliveryPage);
    fixture.componentRef.setInput('token', 'tok');
    fixture.detectChanges();
    const req = http.expectOne(URL);
    if (first === 404) req.flush({ statusCode: 404, code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    else if (first === 500) req.flush({}, { status: 500, statusText: 'Error' });
    else req.flush(first);
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex and keeps the token out of the page meta', async () => {
    await setup(view());
    expect(metaSet).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(JSON.stringify(metaSet.mock.calls)).not.toContain('tok');
  });

  it('shows the date as d.M.yyyy with the window, and both buttons', async () => {
    await setup(view());
    expect(text()).toContain('9.12.2026');
    expect(text()).toContain('09:00');
    expect(text()).toContain('13:00');
    expect(el().querySelectorAll('bdi').length).toBeGreaterThanOrEqual(2);
    expect(button('מאשר/ת את המועד')).toBeTruthy();
    expect(button('מבקש/ת מועד אחר')).toBeTruthy();
  });

  it('confirm sends the answer, disables the buttons while sending, then thanks', async () => {
    await setup(view());
    button('מאשר/ת את המועד').click();
    fixture.detectChanges();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ answer: 'confirm' });
    expect(button('מאשר/ת את המועד').disabled).toBe(true);
    expect(button('מבקש/ת מועד אחר').disabled).toBe(true);
    req.flush(view('confirmed'));
    await settle();
    expect(text()).toContain('תודה, המועד אושר');
    expect(el().querySelector('button')).toBeNull();
  });

  it('change sends the trimmed note and shows the follow-up text', async () => {
    await setup(view());
    const note = el().querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = '  רק אחרי הצהריים ';
    note.dispatchEvent(new Event('input'));
    button('מבקש/ת מועד אחר').click();
    const req = http.expectOne(URL);
    expect(req.request.body).toEqual({ answer: 'change', note: 'רק אחרי הצהריים' });
    req.flush(view('change_requested'));
    await settle();
    expect(text()).toContain('קיבלנו, ניצור קשר לתיאום מועד אחר');
  });

  it('change without a note sends no note', async () => {
    await setup(view());
    button('מבקש/ת מועד אחר').click();
    const req = http.expectOne(URL);
    expect(req.request.body).toEqual({ answer: 'change' });
    req.flush(view('change_requested'));
  });

  it('an already answered link shows the result without buttons', async () => {
    await setup(view('confirmed'));
    expect(text()).toContain('תודה, המועד אושר');
    expect(el().querySelector('button')).toBeNull();
  });

  it('an unknown or replaced link says it is not valid', async () => {
    await setup(404);
    expect(text()).toContain('הקישור אינו בתוקף');
    expect(el().querySelector('button')).toBeNull();
  });

  it('a 409 on the answer reloads the slot and shows its state', async () => {
    await setup(view());
    button('מאשר/ת את המועד').click();
    http.expectOne((r) => r.method === 'POST').flush({ code: 'already_answered' }, { status: 409, statusText: 'x' });
    await settle();
    http.expectOne((r) => r.method === 'GET').flush(view('change_requested'));
    await settle();
    expect(text()).toContain('קיבלנו, ניצור קשר לתיאום מועד אחר');
  });

  it('a server error shows a retry that loads again', async () => {
    await setup(500);
    expect(text()).toContain('לא הצלחנו לטעון');
    button('נסו שוב').click();
    http.expectOne(URL).flush(view());
    await settle();
    expect(text()).toContain('9.12.2026');
  });
});
