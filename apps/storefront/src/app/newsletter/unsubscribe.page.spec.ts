import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { NewsletterUnsubscribePage } from './unsubscribe.page';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('NewsletterUnsubscribePage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<NewsletterUnsubscribePage>;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = () => el().querySelector<HTMLButtonElement>('button')!;

  function open(t?: string) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(NewsletterUnsubscribePage);
    if (t !== undefined) fixture.componentRef.setInput('t', t);
    fixture.detectChanges();
    return set;
  }
  afterEach(() => http.verify());

  it('is noindex and does nothing on load (mail scanners prefetch links)', () => {
    const set = open('tok');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    http.expectNone('/api/newsletter/unsubscribe');
    expect(button().textContent?.trim()).toBe('הסרה מרשימת הדיוור');
  });

  it('unsubscribes on the click and shows the done state', async () => {
    open('tok9');
    button().click();
    const req = http.expectOne('/api/newsletter/unsubscribe');
    expect(req.request.body).toEqual({ token: 'tok9' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    fixture.detectChanges();
    expect(el().textContent).toContain('הוסרתם מרשימת הדיוור');
    expect(el().querySelector('button')).toBeNull();
  });

  it('a failed call keeps the button and shows an alert', async () => {
    open('tok9');
    button().click();
    http.expectOne('/api/newsletter/unsubscribe').flush({}, { status: 500, statusText: 'Error' });
    await tick();
    fixture.detectChanges();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('משהו השתבש');
    expect(button()).not.toBeNull();
  });
});
