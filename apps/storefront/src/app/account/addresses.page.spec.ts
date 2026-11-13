import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { LocalityField } from '../checkout/locality-field';
import { CustomerStore } from './customer.store';
import { AddressesPage } from './addresses.page';
import { addressView, failWith, provideAccountTesting, signedIn, typeInto, tick, flushCarts } from './account.testing';

describe('AddressesPage', () => {
  let fixture: ComponentFixture<AddressesPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const q = <T extends HTMLElement>(sel: string) => el().querySelector<T>(sel)!;
  const button = (label: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(list = [addressView()]) {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    fixture = TestBed.createComponent(AddressesPage);
    fixture.detectChanges();
    await tick();
    http.expectOne('/api/account/addresses').flush(list);
    await settle();
  }

  function pickLocality() {
    const field = fixture.debugElement.query(By.directive(LocalityField)).componentInstance as LocalityField;
    field.value.set({ id: 5000, nameHe: 'תל אביב - יפו' });
    fixture.detectChanges();
  }

  afterEach(() => http.verify());

  it('is noindex and lists the addresses with the default marked', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(AddressesPage);
    fixture.detectChanges();
    await tick();
    http
      .expectOne('/api/account/addresses')
      .flush([addressView(), addressView({ id: 'a2', street: 'ביאליק', isDefault: false })]);
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(el().querySelectorAll('li.address')).toHaveLength(2);
    const badges = [...el().querySelectorAll('li.address')].map((li) =>
      li.querySelector('.badge')?.textContent?.trim(),
    );
    expect(badges).toEqual(['ברירת מחדל', undefined]);
  });

  it('a signed-out answer (401) goes to sign-in with ?next=', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(AddressesPage);
    fixture.detectChanges();
    await tick();
    failWith(http.expectOne('/api/account/addresses'), 401, 'not_authenticated');
    await settle();
    expect(TestBed.inject(CustomerStore).me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/account'], { queryParams: { next: expect.any(String) } });
    flushCarts(http);
  });

  it('shows an empty state', async () => {
    await setup([]);
    expect(text()).toContain('עוד לא שמרתם כתובות');
  });

  it('adds an address: validates first, then posts the input', async () => {
    await setup([]);
    button('הוספת כתובת').click();
    await settle();
    q<HTMLButtonElement>('form.address-form button[type="submit"]').click();
    await settle();
    http.expectNone('/api/account/addresses');
    const street = q('#ad-street');
    expect(street.getAttribute('aria-invalid')).toBe('true');
    expect(q(`#${street.getAttribute('aria-describedby')}`).textContent).toContain('רחוב');
    expect(q('#ad-locality').getAttribute('aria-describedby')).toBeTruthy();

    pickLocality();
    typeInto(q('#ad-street'), 'הרצל');
    typeInto(q('#ad-houseNumber'), '12');
    typeInto(q('#ad-floor'), '3');
    q<HTMLButtonElement>('form.address-form button[type="submit"]').click();
    const req = http.expectOne('/api/account/addresses');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toMatchObject({ localityId: 5000, street: 'הרצל', houseNumber: '12', floor: 3 });
    req.flush(addressView());
    await tick();
    http.expectOne('/api/account/addresses').flush([addressView()]);
    await settle();
    expect(el().querySelectorAll('li.address')).toHaveLength(1);
    expect(el().querySelector('form.address-form')).toBeNull();
  });

  it('shows a server field error on its field', async () => {
    await setup([]);
    button('הוספת כתובת').click();
    await settle();
    pickLocality();
    typeInto(q('#ad-street'), 'הרצל');
    typeInto(q('#ad-houseNumber'), '12');
    typeInto(q('#ad-floor'), '3');
    q<HTMLButtonElement>('form.address-form button[type="submit"]').click();
    failWith(http.expectOne('/api/account/addresses'), 400, 'invalid_field', {
      field: 'address.street',
      messageHe: 'הרחוב לא תקין',
    });
    await settle();
    expect(q('#ad-street').getAttribute('aria-invalid')).toBe('true');
    expect(text()).toContain('הרחוב לא תקין');
  });

  it('shows the limit message when 20 addresses are saved', async () => {
    await setup([]);
    button('הוספת כתובת').click();
    await settle();
    pickLocality();
    typeInto(q('#ad-street'), 'הרצל');
    typeInto(q('#ad-houseNumber'), '12');
    typeInto(q('#ad-floor'), '3');
    q<HTMLButtonElement>('form.address-form button[type="submit"]').click();
    failWith(http.expectOne('/api/account/addresses'), 409, 'address_limit');
    await settle();
    expect(text()).toContain('אפשר לשמור עד 20 כתובות');
  });

  it('edits an address with PUT', async () => {
    await setup();
    button('עריכה').click();
    await settle();
    expect(q<HTMLInputElement>('#ad-street').value).toBe('הרצל');
    typeInto(q('#ad-street'), 'ביאליק');
    q<HTMLButtonElement>('form.address-form button[type="submit"]').click();
    const req = http.expectOne('/api/account/addresses/a1');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toMatchObject({ street: 'ביאליק', localityId: 5000 });
    req.flush(addressView({ street: 'ביאליק' }));
    await tick();
    http.expectOne('/api/account/addresses').flush([addressView({ street: 'ביאליק' })]);
    await settle();
    expect(text()).toContain('ביאליק');
  });

  it('makes another address the default', async () => {
    await setup([addressView(), addressView({ id: 'a2', street: 'ביאליק', isDefault: false })]);
    button('קביעה כברירת מחדל').click();
    const req = http.expectOne('/api/account/addresses/a2');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toMatchObject({ isDefault: true, street: 'ביאליק' });
    req.flush(addressView({ id: 'a2', street: 'ביאליק', isDefault: true }));
    await tick();
    http
      .expectOne('/api/account/addresses')
      .flush([addressView({ id: 'a2', street: 'ביאליק', isDefault: true }), addressView({ isDefault: false })]);
    await settle();
    expect(el().querySelectorAll('li.address')[0].textContent).toContain('ביאליק');
  });

  it('deletes only after a confirmation', async () => {
    await setup();
    button('מחיקה').click();
    await settle();
    http.expectNone('/api/account/addresses/a1');
    expect(text()).toContain('למחוק את הכתובת?');
    button('כן, למחוק').click();
    const req = http.expectOne('/api/account/addresses/a1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    http.expectOne('/api/account/addresses').flush([]);
    await settle();
    expect(el().querySelectorAll('li.address')).toHaveLength(0);
  });
});
