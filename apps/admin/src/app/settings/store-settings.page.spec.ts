import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { StoreInfo } from '@hg/models';
import { StoreSettingsPage } from './store-settings.page';

const URL = '/api/admin/store';
const STORE: StoreInfo = {
  id: 1,
  nameHe: 'החנות',
  address: 'הרצל 1, תל אביב',
  hoursHe: 'א׳–ה׳ 10:00–19:00',
  phone: '03-1234567',
};

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('StoreSettingsPage ("החנות")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(StoreSettingsPage);
    fixture.detectChanges();
    http.expectOne(URL).flush(STORE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const field = (name: string) => el.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    const type = async (name: string, value: string) => {
      const input = field(name);
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(fixture);
    };
    const submit = async () => {
      el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
    };
    return { fixture, el, field, type, submit };
  }

  it('shows the saved details and saves trimmed edits', async () => {
    const { fixture, el, field, type, submit } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('החנות');
    expect(field('nameHe').value).toBe('החנות');
    expect(field('address').value).toBe('הרצל 1, תל אביב');
    await type('nameHe', '  סלון נסטו  ');
    await type('phone', '');
    await submit();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({
      nameHe: 'סלון נסטו',
      address: 'הרצל 1, תל אביב',
      hoursHe: 'א׳–ה׳ 10:00–19:00',
      phone: '',
    });
    req.flush({ ...STORE, nameHe: 'סלון נסטו', phone: '' });
    await settle(fixture);
    expect(field('nameHe').value).toBe('סלון נסטו');
  });

  it('refuses an empty or too long name and too long other fields before sending', async () => {
    const { el, type, submit } = await open();
    for (const value of ['', '   ', 'א'.repeat(81)]) {
      await type('nameHe', value);
      await submit();
      expect(el.querySelector('[role=alert]')?.textContent).toContain('שם החנות');
    }
    await type('nameHe', 'חנות');
    await type('address', 'ב'.repeat(201));
    await submit();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('עד 200 תווים');
  });
});
