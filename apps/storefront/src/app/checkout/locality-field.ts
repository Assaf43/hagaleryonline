import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, filter, map, of, switchMap } from 'rxjs';
import type { LocalityOption } from '@hg/models';
import { CheckoutApi } from './checkout.api';

const DEBOUNCE_MS = 200;

/**
 * The checkout's locality picker (spec §5.1): a combobox over GET /api/localities with the keyboard pattern of
 * the header search box (arrows move and wrap, Enter picks, Escape closes). Only a picked locality is a value;
 * typing again clears it. Renders its own label and error, so the error is tied to the input.
 */
@Component({
  selector: 'hg-locality-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusout)': 'focusOut($event)' },
  template: `
    <label class="field-label" [for]="inputId()">יישוב</label>
    <input
      class="input"
      type="text"
      autocomplete="off"
      role="combobox"
      aria-autocomplete="list"
      maxlength="100"
      [id]="inputId()"
      [value]="text()"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() && results().length ? listId() : null"
      [attr.aria-activedescendant]="open() ? activeId() : null"
      [attr.aria-invalid]="error() ? true : null"
      [attr.aria-describedby]="error() ? errorId() : null"
      (input)="typing($event)"
      (keydown)="keydown($event)"
    />
    <div class="visually-hidden" role="status" aria-live="polite">
      @if (open()) {
        {{ results().length ? results().length + ' יישובים' : 'לא נמצא יישוב בשם הזה' }}
      }
    </div>
    @if (open()) {
      <div class="panel" (mousedown)="$event.preventDefault()">
        @if (results().length) {
          <ul class="list" role="listbox" [id]="listId()" aria-label="יישובים">
            @for (r of results(); track r.id; let i = $index) {
              <li
                role="option"
                [id]="optionId(i)"
                [class.active]="activeIndex() === i"
                [attr.aria-selected]="activeIndex() === i"
                (mouseenter)="activeIndex.set(i)"
                (click)="pick(r)"
              >
                {{ r.nameHe }}
              </li>
            }
          </ul>
        } @else {
          <p class="empty">לא נמצא יישוב בשם הזה</p>
        }
      </div>
    }
    @if (error()) {
      <p class="field-error" [id]="errorId()">{{ error() }}</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-1);
      position: relative;
    }

    .panel {
      position: absolute;
      inset-inline: 0;
      inset-block-start: 100%;
      z-index: 20;
      background: var(--color-surface);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-float);
      max-block-size: 320px;
      overflow-y: auto;
    }

    .list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li {
      display: flex;
      align-items: center;
      min-block-size: 44px;
      padding: var(--space-2) var(--space-4);
      cursor: pointer;
    }

    li.active,
    li:hover {
      background: var(--color-surface-alt);
    }

    .empty {
      margin: 0;
      padding: var(--space-4);
      font-size: var(--font-small);
      color: var(--color-text-muted);
    }
  `,
})
export class LocalityField {
  readonly inputId = input.required<string>();
  readonly error = input('');
  /** The picked locality; null while nothing from the list is picked. */
  readonly value = model<LocalityOption | null>(null);

  private readonly api = inject(CheckoutApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly typed$ = new Subject<string>();
  /** Set by a pick or Escape: drops results that are still pending. */
  private dismissed = false;
  private scrollPending = false;

  protected readonly text = signal('');
  protected readonly results = signal<LocalityOption[]>([]);
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(-1);

  protected readonly listId = computed(() => `${this.inputId()}-list`);
  protected readonly errorId = computed(() => `${this.inputId()}-error`);
  protected readonly activeId = computed(() => (this.activeIndex() >= 0 ? this.optionId(this.activeIndex()) : null));
  protected optionId(i: number) {
    return `${this.inputId()}-opt-${i}`;
  }

  constructor() {
    // A value set from outside (or picked) shows its name.
    effect(() => {
      const v = this.value();
      if (v) this.text.set(v.nameHe);
    });

    afterRenderEffect(() => {
      if (this.activeIndex() < 0 || !this.scrollPending) return;
      this.scrollPending = false;
      this.host.nativeElement
        .querySelector<HTMLElement>('[role="option"].active')
        ?.scrollIntoView?.({ block: 'nearest' });
    });

    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      this.typed$
        .pipe(
          map((v) => v.trim()),
          debounceTime(DEBOUNCE_MS),
          filter(() => !this.dismissed),
          switchMap((q) =>
            q
              ? this.api.localities(q).pipe(
                  map((rows) => ({ q, rows })),
                  catchError(() => of({ q, rows: null })),
                )
              : of({ q, rows: null }),
          ),
          takeUntilDestroyed(inject(DestroyRef)),
        )
        .subscribe(({ q, rows }) => {
          if (this.dismissed || q !== this.text().trim()) return;
          this.results.set(rows ?? []);
          this.activeIndex.set(-1);
          this.open.set(rows !== null);
        });
    }
  }

  protected typing(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    this.dismissed = false;
    if (this.value()) this.value.set(null);
    this.activeIndex.set(-1);
    if (!value.trim()) this.close();
    this.typed$.next(value);
  }

  protected keydown(event: KeyboardEvent) {
    const n = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!this.open() || n === 0) return;
        event.preventDefault();
        this.scrollPending = true;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const cur = this.activeIndex();
        this.activeIndex.set(cur < 0 ? (step > 0 ? 0 : n - 1) : (cur + step + n) % n);
        return;
      }
      case 'Escape':
        if (this.open()) {
          event.preventDefault();
          this.dismissed = true;
          this.close();
        }
        return;
      case 'Enter': {
        // Never submits the checkout form from this field.
        event.preventDefault();
        const active = this.open() ? this.results()[this.activeIndex()] : undefined;
        if (active) this.pick(active);
        return;
      }
    }
  }

  protected pick(locality: LocalityOption) {
    this.dismissed = true;
    this.value.set(locality);
    this.text.set(locality.nameHe);
    this.close();
  }

  protected focusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !this.host.nativeElement.contains(next)) this.close();
  }

  private close() {
    this.open.set(false);
    this.activeIndex.set(-1);
  }
}
