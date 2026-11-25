import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { errorMessage } from './core/errors';
import { LoginPage } from './login/login.page';

describe('LoginPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
  });

  it('renders the Hebrew login form with "remember this device"', async () => {
    const fixture = TestBed.createComponent(LoginPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('כניסה לממשק הניהול');
    expect(el.querySelector('input[type="email"]')).toBeTruthy();
    expect(el.textContent).toContain('לזכור את המכשיר הזה ל-30 יום');
  });
});

describe('LoginPage after an idle logout', () => {
  const statusFor = async (reason: string | null) => {
    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(reason ? { reason } : {}) } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LoginPage);
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).querySelector('[role="status"]')?.textContent;
  };

  it('says why the session ended', async () => {
    expect(await statusFor('idle')).toContain('החיבור הסתיים אחרי 8 שעות ללא פעילות. יש להתחבר מחדש.');
  });

  it('says nothing on a normal visit', async () => {
    expect(await statusFor(null)).toBeUndefined();
  });
});

describe('errorMessage', () => {
  const apiError = (status: number, body: object) => new HttpErrorResponse({ status, error: body });

  it('explains weak passwords by reason', () => {
    expect(errorMessage(apiError(400, { code: 'weak_password', reason: 'too_short' }))).toContain('12 תווים');
    expect(errorMessage(apiError(400, { code: 'weak_password', reason: 'too_personal' }))).toContain('השם או האימייל');
  });

  it('tells how long to wait after too many attempts', () => {
    expect(errorMessage(apiError(429, { code: 'too_many_attempts', retryAfterSeconds: 30 }))).toContain('30 שניות');
    expect(errorMessage(apiError(429, { code: 'too_many_attempts', retryAfterSeconds: 120 }))).toContain('2 דקות');
  });

  it('falls back to a generic message', () => {
    expect(errorMessage(apiError(500, {}))).toBe('משהו השתבש. נסו שוב.');
    expect(errorMessage(apiError(0, {}))).toContain('אין חיבור לשרת');
  });
});
