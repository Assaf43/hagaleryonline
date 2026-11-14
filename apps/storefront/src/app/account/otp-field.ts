import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const LENGTH = 6;
/** The customer may ask for a new code after this long (spec §6.2: up to 3 codes per target per 10 minutes). */
export const RESEND_AFTER_SECONDS = 60;

/**
 * The one-time code field (ACC-01): six single-digit inputs with `autocomplete="one-time-code"` (the phone offers
 * the SMS code), a paste in any box fills all six, typing moves on, Backspace on an empty box moves back. Emits
 * `completed` with the six digits when the last one is filled, and `resend` after the 60-second wait. Each box has
 * its own accessible name; the group is named by `label`, and `error` is tied to every box (aria-describedby).
 * The boxes are laid out left-to-right (a code reads like a number, also on a right-to-left page).
 */
@Component({
  selector: 'hg-otp-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="otp" role="group" [attr.aria-labelledby]="labelId()">
      <span class="field-label" [id]="labelId()">{{ label() }}</span>
      <div class="boxes" dir="ltr">
        @for (d of digits(); track $index; let i = $index) {
          <input
            class="input box"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            [id]="idPrefix() + '-' + i"
            [attr.aria-label]="'ספרה ' + (i + 1) + ' מתוך ' + length"
            [attr.aria-invalid]="error() ? true : null"
            [attr.aria-describedby]="error() ? errorId() : null"
            [disabled]="disabled()"
            [value]="d"
            (input)="typed(i, $event)"
            (keydown)="keydown(i, $event)"
            (paste)="paste($event)"
            (focus)="select($event)"
          />
        }
      </div>
      @if (error()) {
        <p class="field-error" role="alert" [id]="errorId()">{{ error() }}</p>
      }
      <button type="button" class="btn btn-secondary resend" [disabled]="resendIn() > 0" (click)="resendClick()">
        @if (resendIn() > 0) {
          שליחת קוד חדש בעוד <bdi>{{ resendIn() }}</bdi> שניות
        } @else {
          שליחת קוד חדש
        }
      </button>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .otp {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }

    .boxes {
      display: flex;
      gap: var(--space-2);
    }

    .box {
      inline-size: 44px;
      padding-inline: 0;
      text-align: center;
      font-size: var(--font-h3);
    }

    .field-error {
      margin: 0;
    }
  `,
})
export class OtpField {
  readonly label = input.required<string>();
  /** Prefix of the box ids (unique on the page). */
  readonly idPrefix = input.required<string>();
  readonly error = input('');
  readonly disabled = input(false);
  readonly completed = output<string>();
  readonly resend = output<void>();
  /** The customer changed a digit (typing, paste, delete): a page drops any code it kept from before. */
  readonly edited = output<void>();

  protected readonly length = LENGTH;
  protected readonly digits = signal<string[]>(Array<string>(LENGTH).fill(''));
  protected readonly resendIn = signal(0);
  protected readonly labelId = computed(() => `${this.idPrefix()}-label`);
  protected readonly errorId = computed(() => `${this.idPrefix()}-error`);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.restartTimer();
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  /** Empties the boxes and focuses the first (after a wrong code). */
  clear(): void {
    this.digits.set(Array<string>(LENGTH).fill(''));
    this.focusBox(0);
  }

  /** Focuses the first empty box. */
  focus(): void {
    this.focusBox(Math.max(0, this.digits().indexOf('')));
  }

  /** Starts the 60-second wait again (the parent sent a code of its own). */
  restartTimer(): void {
    this.stopTimer();
    if (!this.browser) return;
    this.resendIn.set(RESEND_AFTER_SECONDS);
    this.timer = setInterval(() => {
      this.resendIn.update((n) => Math.max(0, n - 1));
      if (this.resendIn() === 0) this.stopTimer();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  protected resendClick(): void {
    if (this.resendIn() > 0) return;
    this.digits.set(Array<string>(LENGTH).fill(''));
    this.restartTimer();
    this.resend.emit();
    this.focusBox(0);
  }

  protected typed(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const typed = input.value.replace(/\D/g, '');
    this.edited.emit();
    if (!typed) {
      this.set(index, '');
      input.value = '';
      return;
    }
    // One digit (typing) or several (an autofill that put the whole code in one box).
    this.fill(index, typed);
  }

  protected paste(event: ClipboardEvent): void {
    event.preventDefault();
    const typed = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '');
    if (typed) {
      this.edited.emit();
      this.fill(0, typed);
    }
  }

  protected keydown(index: number, event: KeyboardEvent): void {
    switch (event.key) {
      case 'Backspace':
        if (!this.digits()[index] && index > 0) {
          event.preventDefault();
          this.edited.emit();
          this.set(index - 1, '');
          this.focusBox(index - 1);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        this.focusBox(index - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        this.focusBox(index + 1);
        return;
    }
  }

  protected select(event: FocusEvent): void {
    (event.target as HTMLInputElement).select();
  }

  private set(index: number, digit: string): void {
    this.digits.update((d) => d.map((v, i) => (i === index ? digit : v)));
  }

  private fill(start: number, typed: string): void {
    const next = [...this.digits()];
    let last = start;
    for (const [offset, ch] of [...typed].slice(0, LENGTH - start).entries()) {
      next[start + offset] = ch;
      last = start + offset;
    }
    this.digits.set(next);
    // The inputs hold their own text until the change detection runs: keep them in step right away.
    this.sync(next);
    if (next.every((d) => d)) {
      this.focusBox(LENGTH - 1);
      this.completed.emit(next.join(''));
    } else {
      this.focusBox(Math.min(last + 1, LENGTH - 1));
    }
  }

  private sync(values: string[]): void {
    this.boxes().forEach((b, i) => (b.value = values[i]));
  }

  private boxes(): HTMLInputElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLInputElement>('input')];
  }

  private focusBox(index: number): void {
    this.sync(this.digits());
    this.boxes()[Math.min(Math.max(index, 0), LENGTH - 1)]?.focus();
  }
}
