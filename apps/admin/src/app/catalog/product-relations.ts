import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, model, signal } from '@angular/core';
import { CdkDrag, CdkDragHandle, CdkDropList, type CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { LucideChevronDown, LucideChevronUp, LucideGripVertical, LucideTrash2 } from '@lucide/angular';
import type { AdminProductRow, RelatedPick } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { formatPrice } from './catalog-format';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
const MAX_RESULTS = 8;

/**
 * Hand-picked related products for one list ("goes with" or "similar", spec §4.4): search, add to
 * the end, reorder by drag or with buttons for keyboard users, remove. The parent saves the list.
 */
@Component({
  selector: 'hg-product-relations',
  imports: [
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    LucideChevronDown,
    LucideChevronUp,
    LucideGripVertical,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-relations.html',
  styleUrl: './product-relations.scss',
})
export class ProductRelations {
  /** The product being edited, so it is left out of the results; null for a new product. */
  readonly productId = input<number | null>(null);
  readonly title = input.required<string>();
  readonly autofillLabel = input('השלמה אוטומטית');
  readonly disabled = input(false);
  readonly picks = model<RelatedPick[]>([]);
  readonly autofill = model<boolean>(false);

  private readonly api = inject(CatalogApi);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;

  protected readonly query = signal('');
  protected readonly results = signal<AdminProductRow[]>([]);
  protected readonly searched = signal(false);
  protected readonly error = signal('');
  protected readonly format = formatPrice;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected onInput(text: string) {
    this.query.set(text);
    clearTimeout(this.timer);
    this.requestId++;
    this.results.set([]);
    if (text.trim().length < MIN_CHARS) {
      this.requestId++;
      this.results.set([]);
      this.searched.set(false);
      return;
    }
    this.timer = setTimeout(() => this.search(text.trim()), DEBOUNCE_MS);
  }

  private async search(q: string) {
    const id = ++this.requestId;
    try {
      const page = await this.api.products({ q, status: 'all', page: 1 });
      if (id !== this.requestId) return;
      this.error.set('');
      this.results.set(this.available(page.items));
    } catch (e) {
      if (id !== this.requestId) return;
      this.results.set([]);
      this.error.set(errorMessage(e));
    }
    this.searched.set(true);
  }

  private available(items: AdminProductRow[]): AdminProductRow[] {
    const taken = new Set(this.picks().map((p) => p.id));
    return items.filter((r) => r.id !== this.productId() && !taken.has(r.id)).slice(0, MAX_RESULTS);
  }

  protected add(row: AdminProductRow) {
    if (this.disabled() || this.picks().some((p) => p.id === row.id)) return;
    this.picks.set([
      ...this.picks(),
      { id: row.id, modelName: row.modelName, nameHe: row.nameHe, active: row.active, thumbnailUrl: row.thumbnailUrl },
    ]);
    this.results.update((list) => list.filter((r) => r.id !== row.id));
  }

  /** Enter adds the first result. */
  protected addFirst(event: Event) {
    event.preventDefault();
    const first = this.results()[0];
    if (first) this.add(first);
  }

  protected drop(event: CdkDragDrop<RelatedPick[]>) {
    this.move(event.previousIndex, event.currentIndex);
  }

  protected move(from: number, to: number) {
    if (this.disabled() || from === to || to < 0 || to >= this.picks().length) return;
    const next = [...this.picks()];
    moveItemInArray(next, from, to);
    this.picks.set(next);
  }

  protected remove(index: number) {
    if (this.disabled()) return;
    this.picks.set(this.picks().filter((_, i) => i !== index));
  }
}
