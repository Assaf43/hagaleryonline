import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { LocalityOption } from '@hg/models';
import { errorMessage } from '../core/errors';
import { ShippingApi } from '../core/shipping.api';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

/**
 * Adds localities to a zone through the public localities search. Localities already in this zone are left out;
 * one in another zone is shown with that zone's name and cannot be picked (a locality is in one zone only).
 */
@Component({
  selector: 'hga-locality-picker',
  imports: [MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-form-field subscriptSizing="dynamic">
      <mat-label>הוספת יישוב</mat-label>
      <input
        matInput
        type="search"
        autocomplete="off"
        [value]="query()"
        (input)="onInput($any($event.target).value)"
        (keydown.enter)="pickFirst($event)"
      />
      <mat-hint>לפחות שני תווים משם היישוב</mat-hint>
    </mat-form-field>
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }
    @if (results().length) {
      <ul class="results" aria-label="יישובים שנמצאו">
        @for (r of results(); track r.id) {
          <li>
            <button type="button" [disabled]="!!otherZone()(r.id)" (click)="pick(r)">
              {{ r.nameHe }}
              @if (otherZone()(r.id); as zone) {
                <span class="taken">(כבר באזור {{ zone }})</span>
              }
            </button>
          </li>
        }
      </ul>
    } @else if (searched() && !error()) {
      <p class="muted">לא נמצאו יישובים להוספה.</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
    }

    .results {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .results button {
      min-block-size: var(--control-height-compact);
      padding-inline: var(--space-3);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-pill);
      background: var(--color-bg);
      color: var(--color-text);
      font: inherit;
      cursor: pointer;
    }

    .results button:disabled {
      cursor: default;
      color: var(--color-text-secondary);
    }

    .taken,
    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .muted {
      margin: 0;
    }
  `,
})
export class LocalityPicker {
  /** Locality codes already in this zone. */
  readonly selected = input<number[]>([]);
  /** The other zone a locality belongs to, if any. */
  readonly otherZone = input<(localityId: number) => string | undefined>(() => undefined);
  readonly picked = output<LocalityOption>();

  private readonly api = inject(ShippingApi);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;

  protected readonly query = signal('');
  protected readonly results = signal<LocalityOption[]>([]);
  protected readonly searched = signal(false);
  protected readonly error = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected onInput(text: string) {
    this.query.set(text);
    clearTimeout(this.timer);
    this.requestId++;
    this.results.set([]);
    this.searched.set(false);
    if (text.trim().length >= MIN_CHARS) this.timer = setTimeout(() => void this.search(text.trim()), DEBOUNCE_MS);
  }

  private async search(q: string) {
    const id = ++this.requestId;
    try {
      const found = await this.api.localities(q);
      if (id !== this.requestId) return;
      const taken = new Set(this.selected());
      this.error.set('');
      this.results.set(found.filter((l) => !taken.has(l.id)));
    } catch (e) {
      if (id !== this.requestId) return;
      this.results.set([]);
      this.error.set(errorMessage(e));
    }
    this.searched.set(true);
  }

  protected pick(locality: LocalityOption) {
    if (this.otherZone()(locality.id)) return;
    this.picked.emit(locality);
    this.results.update((list) => list.filter((l) => l.id !== locality.id));
  }

  /** Enter adds the first locality that can be added. */
  protected pickFirst(event: Event) {
    event.preventDefault();
    const first = this.results().find((l) => !this.otherZone()(l.id));
    if (first) this.pick(first);
  }
}
