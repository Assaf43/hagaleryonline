import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CONTENT_LIMITS, type ProductSource, type RelatedPick } from '@hg/models';
import { ProductRelations } from '../catalog/product-relations';
import type { CatalogApi } from '../core/catalog.api';
import { SOURCE_KIND_LABELS } from './home-sections';
import type { IdOption } from './id-list-field';

type SourceKind = ProductSource['kind'];

const DEFAULT_UNAVAILABLE_NOTE =
  'המקור הזה לא מוצג באתר כרגע (הקטגוריה, החדר או המבצע הוסתרו, הסתיימו או נמחקו), והשורה לא תופיע בדף הבית.';

/** The names of saved manual picks: one read each, a missing product keeps its id and says so. */
export async function loadSourcePicks(catalog: Pick<CatalogApi, 'product'>, ids: number[]): Promise<RelatedPick[]> {
  const found = await Promise.allSettled(ids.map((id) => catalog.product(id)));
  return found.map((r, i): RelatedPick => {
    if (r.status === 'fulfilled') {
      const p = r.value;
      return {
        id: ids[i],
        modelName: p.modelName,
        nameHe: p.nameHe,
        active: p.active,
        thumbnailUrl: p.images[0]?.thumbUrl ?? null,
      };
    }
    return { id: ids[i], modelName: `#${ids[i]}`, nameHe: 'המוצר לא נמצא', active: false, thumbnailUrl: null };
  });
}
const KINDS = Object.keys(SOURCE_KIND_LABELS) as SourceKind[];

/**
 * Where a product row gets its products (spec §4.6): best sellers, newest, a category, a room, a promotion or products
 * picked by hand (the same search as the "המלצות" of a product). The promotion list holds only promotions the site can
 * use (automatic, on categories or products, not members-only); the API checks again (`invalid_source`).
 */
@Component({
  selector: 'hga-product-source-field',
  imports: [MatFormFieldModule, MatSelectModule, ProductRelations],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home.scss',
  template: `
    <div class="list-field">
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>מקור המוצרים</mat-label>
        <mat-select [value]="source().kind" (selectionChange)="setKind($event.value)">
          @for (k of kinds; track k) {
            <mat-option [value]="k">{{ labels[k] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      @switch (source().kind) {
        @case ('category') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>קטגוריה</mat-label>
            <mat-select [value]="selectedId()" (selectionChange)="setId($event.value)">
              @for (o of withCurrent(categories()); track o.id) {
                <mat-option [value]="o.id">{{ o.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>כולל את תתי־הקטגוריות</mat-hint>
          </mat-form-field>
        }
        @case ('room') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>חדר</mat-label>
            <mat-select [value]="selectedId()" (selectionChange)="setId($event.value)">
              @for (o of withCurrent(rooms()); track o.id) {
                <mat-option [value]="o.id">{{ o.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        @case ('promotion') {
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>מבצע</mat-label>
            <mat-select [value]="selectedId()" (selectionChange)="setId($event.value)">
              @for (o of withCurrent(promotions()); track o.id) {
                <mat-option [value]="o.id">{{ o.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>מבצע אוטומטי על קטגוריות או מוצרים. לא מבצע על כל ההזמנה ולא לחברי מועדון בלבד.</mat-hint>
          </mat-form-field>
          @if (!promotions().length) {
            <p class="muted">אין כרגע מבצע מתאים. אפשר ליצור אחד במסך "מבצעים וקופונים".</p>
          }
        }
        @case ('manual') {
          <hg-product-relations
            title="מוצרים שנבחרו"
            [showAutofill]="false"
            [disabled]="loading()"
            [picks]="picks()"
            (picksChange)="setPicks($event)"
          />
          <p class="muted">עד {{ maxProducts }} מוצרים, בסדר שבו הם מוצגים. מוצר מוסתר לא יוצג באתר.</p>
          @if (unavailableProductIds().length) {
            <p class="mark-note">
              {{ unavailableProductIds().length }} מהמוצרים לא מוצגים באתר כרגע (מוסתרים או שנמחקו).
            </p>
          }
        }
      }

      @if (unavailable() && source().kind !== 'manual') {
        <p class="mark-note">{{ unavailableNote() }}</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </div>
  `,
})
export class ProductSourceField {
  readonly categories = input<IdOption[]>([]);
  readonly rooms = input<IdOption[]>([]);
  readonly promotions = input<IdOption[]>([]);
  /** The API says the site cannot show this source now. */
  readonly unavailable = input(false);
  /** What the marked source means for this screen (a home row is not shown; a landing page shows an empty grid). */
  readonly unavailableNote = input(DEFAULT_UNAVAILABLE_NOTE);
  readonly unavailableProductIds = input<number[]>([]);
  readonly error = input('');
  /** The names of a saved manual source are still loading: the picker waits, so the saved ids are never dropped. */
  readonly loading = input(false);
  readonly source = model.required<ProductSource>();
  /** The products of a manual source, with names (the source itself holds ids only). */
  readonly picks = model<RelatedPick[]>([]);

  protected readonly kinds = KINDS;
  protected readonly labels = SOURCE_KIND_LABELS;
  protected readonly maxProducts = CONTENT_LIMITS.manualProducts;

  protected readonly selectedId = computed(() => {
    const s = this.source();
    return s.kind === 'category' || s.kind === 'room' || s.kind === 'promotion' ? s.id : 0;
  });

  /** The options plus the saved choice when it is no longer in the set, so the drop-down still shows it. */
  protected withCurrent(options: IdOption[]): IdOption[] {
    const id = this.selectedId();
    return id > 0 && !options.some((o) => o.id === id) ? [{ id, label: `#${id} (לא נמצא)` }, ...options] : options;
  }

  protected setKind(kind: SourceKind) {
    if (kind === this.source().kind) return;
    switch (kind) {
      case 'bestsellers':
      case 'newest':
        this.source.set({ kind });
        break;
      case 'manual':
        this.source.set({ kind, productIds: this.picks().map((p) => p.id) });
        break;
      default:
        this.source.set({ kind, id: 0 });
    }
  }

  protected setId(id: number) {
    const s = this.source();
    if (s.kind === 'category' || s.kind === 'room' || s.kind === 'promotion') this.source.set({ kind: s.kind, id });
  }

  protected setPicks(picks: RelatedPick[]) {
    this.picks.set(picks);
    this.source.set({ kind: 'manual', productIds: picks.map((p) => p.id) });
  }
}
