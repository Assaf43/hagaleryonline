import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ReturnWindowPage } from './return-window.page';

const URL = '/api/admin/settings/store';

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('ReturnWindowPage ("ימי החזרה")', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open() {
    const fixture = TestBed.createComponent(ReturnWindowPage);
    fixture.detectChanges();
    http.expectOne(URL).flush({ returnWindowDays: 14 });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('input[name="returnWindowDays"]')!;
    const type = async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(fixture);
    };
    const submit = async () => {
      el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle(fixture);
    };
    return { fixture, el, input, type, submit };
  }

  it('shows the saved days and saves a new whole number', async () => {
    const { fixture, el, input, type, submit } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('ימי החזרה');
    expect(input.value).toBe('14');
    await type('30');
    await submit();
    const req = http.expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ returnWindowDays: 30 });
    req.flush({ returnWindowDays: 30 });
    await settle(fixture);
    expect(input.value).toBe('30');
  });

  it('refuses 0, 61 and fractions before sending', async () => {
    const { el, type, submit } = await open();
    for (const value of ['0', '61', '2.5', '']) {
      await type(value);
      await submit();
      expect(el.querySelector('[role=alert]')?.textContent).toContain('בין 1 ל־60');
    }
  });
});
