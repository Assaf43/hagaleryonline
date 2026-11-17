import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { LucideChevronDown, LucideChevronUp, LucideTrash2 } from '@lucide/angular';
import { moveItem } from './home-sections';

export interface IdOption {
  id: number;
  label: string;
}

/**
 * An ordered list of ids picked from a fixed set (banners of a hero or a pair, category tiles): add from a drop-down,
 * up / down buttons, remove. An id the set no longer holds, or that the site cannot show now, keeps its row with a
 * mark so the editor sees it and can remove it.
 */
@Component({
  selector: 'hga-id-list-field',
  imports: [MatButtonModule, MatFormFieldModule, MatSelectModule, LucideChevronDown, LucideChevronUp, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home.scss',
  template: `
    <div class="list-field">
      <h3>{{ title() }}</h3>
      @if (ids().length) {
        <ol class="picked" [attr.aria-label]="title()">
          @for (id of ids(); track id; let i = $index; let last = $last) {
            <li class="pick">
              <span class="text">{{ labelOf(id) }}</span>
              @if (marked(id); as mark) {
                <span class="mark">{{ mark }}</span>
              }
              <span class="actions">
                <button
                  matIconButton
                  type="button"
                  [disabled]="i === 0"
                  (click)="move(i, -1)"
                  [attr.aria-label]="'הזזה למעלה: ' + labelOf(id)"
                >
                  <svg lucideChevronUp></svg>
                </button>
                <button
                  matIconButton
                  type="button"
                  [disabled]="last"
                  (click)="move(i, 1)"
                  [attr.aria-label]="'הזזה למטה: ' + labelOf(id)"
                >
                  <svg lucideChevronDown></svg>
                </button>
                <button
                  matIconButton
                  type="button"
                  class="delete"
                  (click)="remove(i)"
                  [attr.aria-label]="'הסרה: ' + labelOf(id)"
                >
                  <svg lucideTrash2></svg>
                </button>
              </span>
            </li>
          }
        </ol>
      } @else {
        <p class="muted">{{ emptyText() }}</p>
      }
      @if (addable().length && ids().length < max()) {
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>{{ addLabel() }}</mat-label>
          <mat-select [value]="null" (selectionChange)="add($event.value)">
            @for (o of addable(); track o.id) {
              <mat-option [value]="o.id">{{ o.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      @if (hint()) {
        <p class="muted">{{ hint() }}</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </div>
  `,
})
export class IdListField {
  readonly title = input.required<string>();
  readonly addLabel = input('הוספה');
  readonly emptyText = input('עוד לא נבחר כלום.');
  readonly hint = input('');
  readonly error = input('');
  readonly options = input.required<IdOption[]>();
  readonly max = input(99);
  /** Ids the site cannot show now (the API's `unavailable`). */
  readonly unavailable = input<number[]>([]);
  /** The text of the mark of an unavailable id. */
  readonly unavailableText = input('לא מוצג באתר כרגע');
  readonly missingText = input('לא נמצא');
  readonly ids = model<number[]>([]);

  protected readonly addable = computed(() => {
    const taken = new Set(this.ids());
    return this.options().filter((o) => !taken.has(o.id));
  });

  protected labelOf(id: number): string {
    return this.options().find((o) => o.id === id)?.label ?? `#${id}`;
  }

  /** "לא נמצא" for an id that no longer exists, else the "not shown now" mark. */
  protected marked(id: number): string {
    if (!this.options().some((o) => o.id === id)) return this.missingText();
    return this.unavailable().includes(id) ? this.unavailableText() : '';
  }

  protected add(id: number | null) {
    if (id === null || this.ids().includes(id) || this.ids().length >= this.max()) return;
    this.ids.set([...this.ids(), id]);
  }

  protected move(index: number, delta: -1 | 1) {
    this.ids.set(moveItem(this.ids(), index, delta));
  }

  protected remove(index: number) {
    this.ids.set(this.ids().filter((_, i) => i !== index));
  }
}
