import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  effect,
  forwardRef,
  input,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { DateAdapter, ErrorStateMatcher, MAT_DATE_FORMATS, MAT_DATE_LOCALE } from '@angular/material/core';
import { MatDatepickerInput, MatDatepickerModule, type MatDatepickerInputEvent } from '@angular/material/datepicker';
import { MatFormFieldModule, type SubscriptSizing } from '@angular/material/form-field';
import { MatInput, MatInputModule } from '@angular/material/input';
import { ISRAEL_DATE_FORMATS, IsraelDateAdapter } from './israel-date-adapter';

export const DATE_FIELD_INVALID = 'תאריך לא תקין (יום.חודש.שנה)';

let nextId = 0;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** A calendar day as the "YYYY-MM-DD" text the API and the forms carry. */
export function toIsoDay(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-MM-DD" → that day at local midnight; anything else → null. */
export function fromIsoDay(text: string | null | undefined): Date | null {
  const m = ISO.exec(text ?? '');
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return date.getMonth() === Number(m[2]) - 1 ? date : null;
}

/**
 * The one date field of the admin: a text box that always reads day.month.year plus a calendar. Its value is the
 * same "" or "YYYY-MM-DD" text a native date input gave, so callers' models and API payloads do not change. Binds
 * with `[(value)]`, `ngModel` or a form control.
 */
@Component({
  selector: 'hga-date-field',
  imports: [MatFormFieldModule, MatInputModule, MatDatepickerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DateField), multi: true },
    { provide: MAT_DATE_LOCALE, useValue: 'he-IL' },
    { provide: DateAdapter, useClass: IsraelDateAdapter },
    { provide: MAT_DATE_FORMATS, useValue: ISRAEL_DATE_FORMATS },
  ],
  styles: `
    :host {
      display: block;
    }
    mat-form-field {
      inline-size: 100%;
    }
    bdi {
      display: contents;
    }
  `,
  template: `
    <mat-form-field [subscriptSizing]="subscriptSizing()">
      <mat-label>{{ label() }}</mat-label>
      <bdi>
        <input
          matInput
          dir="ltr"
          autocomplete="off"
          placeholder="יום.חודש.שנה"
          [id]="inputId() || autoId"
          [name]="name()"
          [required]="required()"
          [disabled]="disabled()"
          [matDatepicker]="picker"
          [min]="minDate()"
          [max]="maxDate()"
          [errorStateMatcher]="matcher"
          (dateInput)="typed($event)"
          (dateChange)="committed($event)"
          (blur)="touched()"
        />
      </bdi>
      <mat-datepicker-toggle matIconSuffix [for]="picker" aria-label="בחירת תאריך" />
      <mat-datepicker #picker />
      @if (shownError()) {
        <mat-error>{{ shownError() }}</mat-error>
      }
    </mat-form-field>
  `,
})
export class DateField implements ControlValueAccessor {
  readonly value = model<string>('');
  readonly label = input('');
  /** "YYYY-MM-DD" bounds of the calendar. */
  readonly min = input('');
  readonly max = input('');
  readonly required = input(false, { transform: booleanAttribute });
  readonly name = input('');
  /** The id of the text box (forms focus a field by it). */
  readonly inputId = input('');
  readonly subscriptSizing = input<SubscriptSizing>('fixed');
  /** The caller's own check (e.g. a range error from the last save) and its message. */
  readonly errorStateMatcher = input<ErrorStateMatcher | null>(null);
  readonly errorText = input('');

  protected readonly disabled = signal(false);
  /** The text in the box is not a date (set when the box is left or the date is picked). */
  private readonly unreadable = signal(false);
  protected readonly minDate = computed(() => fromIsoDay(this.min()));
  protected readonly maxDate = computed(() => fromIsoDay(this.max()));
  protected readonly shownError = computed(() => (this.unreadable() ? DATE_FIELD_INVALID : this.errorText()));
  protected readonly matcher: ErrorStateMatcher = {
    isErrorState: () => this.unreadable() || (this.errorStateMatcher()?.isErrorState(null, null) ?? false),
  };

  protected readonly autoId = `hga-date-${nextId++}`;
  private readonly input = viewChild.required(MatDatepickerInput);
  private readonly control = viewChild.required(MatInput);
  /** The last text this field handed out: a change that is only the echo of it must not rewrite the box. */
  private emitted = '';
  private onChange: (value: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  constructor() {
    // Show a value that came from outside. A half-typed date emits '' and comes back as '': leave the box alone.
    effect(() => {
      const next = this.value();
      const box = this.input();
      if (next === this.emitted) return;
      this.emitted = next;
      this.unreadable.set(false);
      box.value = fromIsoDay(next);
    });
    // MatInput re-reads its error state only for a form control; this field has none inside, so it is told here
    effect(() => {
      const control = this.control();
      this.matcher.isErrorState(null, null); // read here so a change in the typed text or the caller's check re-runs this
      untracked(() => control.updateErrorState());
    });
  }

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }
  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected typed(event: MatDatepickerInputEvent<Date>) {
    this.emit(event.value ? toIsoDay(event.value) : '');
    if (event.value) this.unreadable.set(false);
  }

  protected committed(event: MatDatepickerInputEvent<Date>) {
    this.emit(event.value ? toIsoDay(event.value) : '');
    const text = event.targetElement instanceof HTMLInputElement ? event.targetElement.value.trim() : '';
    this.unreadable.set(!event.value && text !== '');
  }

  protected touched() {
    this.onTouched();
  }

  private emit(next: string) {
    if (next === this.emitted) return;
    this.emitted = next;
    this.value.set(next);
    this.onChange(next);
  }
}
