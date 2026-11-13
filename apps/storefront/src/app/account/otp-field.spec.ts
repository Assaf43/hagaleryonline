import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { OtpField } from './otp-field';
import { pasteInto } from './account.testing';

describe('OtpField', () => {
  let fixture: ComponentFixture<OtpField>;
  const el = () => fixture.nativeElement as HTMLElement;
  const boxes = () => [...el().querySelectorAll<HTMLInputElement>('input')];
  const resendButton = () => el().querySelector<HTMLButtonElement>('button.resend')!;
  let completed: string[];
  let resends: number;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    fixture = TestBed.createComponent(OtpField);
    fixture.componentRef.setInput('label', 'קוד שנשלח ב־SMS');
    fixture.componentRef.setInput('idPrefix', 'otp-a');
    completed = [];
    resends = 0;
    fixture.componentInstance.completed.subscribe((c) => completed.push(c));
    fixture.componentInstance.resend.subscribe(() => resends++);
    fixture.detectChanges();
  });

  afterEach(() => vi.useRealTimers());

  it('has six inputs, each with one-time-code autocomplete and its own accessible name', () => {
    expect(boxes()).toHaveLength(6);
    for (const [i, b] of boxes().entries()) {
      expect(b.getAttribute('autocomplete')).toBe('one-time-code');
      expect(b.getAttribute('inputmode')).toBe('numeric');
      expect(b.getAttribute('aria-label')).toBe(`ספרה ${i + 1} מתוך 6`);
    }
    const group = el().querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    expect(el().textContent).toContain('קוד שנשלח ב־SMS');
  });

  it('paste fills all six boxes and completes', () => {
    pasteInto(boxes()[3], ' 123 456 ');
    fixture.detectChanges();
    expect(
      boxes()
        .map((b) => b.value)
        .join(''),
    ).toBe('123456');
    expect(completed).toEqual(['123456']);
  });

  it('a paste with fewer digits fills from the start and does not complete', () => {
    pasteInto(boxes()[0], '12ab3');
    fixture.detectChanges();
    expect(
      boxes()
        .map((b) => b.value)
        .join(''),
    ).toBe('123');
    expect(completed).toEqual([]);
  });

  it('typing moves forward and completes on the sixth digit; backspace on an empty box goes back', () => {
    const b = boxes();
    for (const [i, d] of ['1', '2', '3', '4', '5'].entries()) {
      b[i].value = d;
      b[i].dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
    }
    expect(document.activeElement).toBe(b[5]);
    b[5].value = '6';
    b[5].dispatchEvent(new Event('input', { bubbles: true }));
    expect(completed).toEqual(['123456']);

    b[5].value = '';
    b[5].dispatchEvent(new Event('input', { bubbles: true }));
    b[5].dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(document.activeElement).toBe(b[4]);
  });

  it('ignores non-digits', () => {
    boxes()[0].value = 'x';
    boxes()[0].dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(boxes()[0].value).toBe('');
  });

  it('resend is disabled for 60 seconds with a countdown, then sends and restarts the timer', () => {
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toContain('60');
    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toContain('30');
    vi.advanceTimersByTime(30_000);
    fixture.detectChanges();
    expect(resendButton().disabled).toBe(false);
    resendButton().click();
    fixture.detectChanges();
    expect(resends).toBe(1);
    expect(resendButton().disabled).toBe(true);
    expect(resendButton().textContent).toContain('60');
  });

  it('clear() empties the boxes and focuses the first', () => {
    pasteInto(boxes()[0], '123456');
    fixture.componentInstance.clear();
    fixture.detectChanges();
    expect(boxes().every((b) => b.value === '')).toBe(true);
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it('shows an error tied to the group', () => {
    fixture.componentRef.setInput('error', 'הקוד שגוי');
    fixture.detectChanges();
    const err = el().querySelector('.field-error')!;
    expect(err.textContent).toContain('הקוד שגוי');
    expect(boxes()[0].getAttribute('aria-describedby')).toBe(err.id);
  });
});
