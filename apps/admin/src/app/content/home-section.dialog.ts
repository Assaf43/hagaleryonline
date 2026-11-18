import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  CONTENT_LIMITS,
  HOME_PRODUCT_COUNTS,
  HOME_SECTION_LABELS_HE,
  type AdminBanner,
  type AdminCategory,
  type AdminPromotionSource,
  type AdminRoom,
  type HomeProductCount,
  type ProductSource,
  type RelatedPick,
} from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { IdListField, type IdOption } from './id-list-field';
import { HOME_MESSAGES, sectionProblems, type HomeDraft } from './home-sections';
import { ProductSourceField } from './product-source-field';

/** What the pickers of the section dialog choose from (loaded once by the home page). */
export interface HomeLookups {
  banners: AdminBanner[];
  categories: AdminCategory[];
  rooms: AdminRoom[];
  promotions: AdminPromotionSource[];
}

export interface HomeSectionDialogData {
  draft: HomeDraft;
  lookups: HomeLookups;
}

/** The promotion picker's options: every promotion the API offers, an ended one marked (the API checks again). */
export function promotionOptions(list: AdminPromotionSource[]): IdOption[] {
  return list.map((p) => ({ id: p.id, label: p.usable ? p.name : `${p.name} (לא פעיל כעת)` }));
}

/** Every category, sub-categories indented under their parent's depth. */
export function categoryOptions(list: AdminCategory[]): IdOption[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const depth = (c: AdminCategory): number =>
    c.parentId !== null && byId.has(c.parentId) ? 1 + depth(byId.get(c.parentId)!) : 0;
  return list.map((c) => ({ id: c.id, label: `${'– '.repeat(depth(c))}${c.nameHe}${c.active ? '' : ' (מוסתרת)'}` }));
}

/**
 * Edit one home page section (spec §5): title, then the settings of its kind: hero banners (up to 5), category tiles
 * (2 to 8), a product row's source and count, banner pair (up to 4). Works on a copy; closes with the edited section
 * or nothing. Settings are checked here, the API checks again.
 */
@Component({
  selector: 'hga-home-section-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    IdListField,
    ProductSourceField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home.scss',
  template: `
    <h2 mat-dialog-title>עריכת אזור: {{ kindLabel() }}</h2>
    <form (submit)="submit($event)">
      <mat-dialog-content class="dialog-form">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>כותרת (לא חובה)</mat-label>
          <input
            matInput
            autocomplete="off"
            [attr.maxlength]="titleMax"
            [ngModel]="title()"
            (ngModelChange)="title.set($event)"
            [ngModelOptions]="{ standalone: true }"
          />
          <mat-hint>{{ titleHint() }}</mat-hint>
        </mat-form-field>

        @switch (draft().kind) {
          @case ('hero') {
            <hga-id-list-field
              title="באנרים"
              addLabel="הוספת באנר"
              emptyText="אין באנרים. יוצג הבאנר הקבוע של האתר."
              hint="מוצג הבאנר הראשון ברשימה שפעיל כרגע. אם אין כזה, מוצג הבאנר הקבוע."
              [options]="bannerOptions()"
              [max]="limits.heroBanners"
              [unavailable]="draft().unavailable.bannerIds"
              [error]="errors()['bannerIds'] ?? ''"
              [ids]="bannerIds()"
              (idsChange)="bannerIds.set($event)"
            />
          }
          @case ('banner_pair') {
            <hga-id-list-field
              title="באנרים"
              addLabel="הוספת באנר"
              emptyText="אין באנרים. האזור לא יוצג."
              hint="מוצגים שני הבאנרים הראשונים ברשימה שפעילים כרגע."
              [options]="bannerOptions()"
              [max]="limits.pairBanners"
              [unavailable]="draft().unavailable.bannerIds"
              [error]="errors()['bannerIds'] ?? ''"
              [ids]="bannerIds()"
              (idsChange)="bannerIds.set($event)"
            />
          }
          @case ('categories') {
            <hga-id-list-field
              title="קטגוריות"
              addLabel="הוספת קטגוריה"
              emptyText="עוד לא נבחרו קטגוריות."
              [hint]="
                'בין ' + limits.categoryTilesMin + ' ל־' + limits.categoryTilesMax + ' קטגוריות, בסדר שבו הן מוצגות.'
              "
              unavailableText="לא מוצגת באתר כרגע"
              [options]="categoryChoices()"
              [max]="limits.categoryTilesMax"
              [unavailable]="draft().unavailable.categoryIds"
              [error]="errors()['categoryIds'] ?? ''"
              [ids]="categoryIds()"
              (idsChange)="categoryIds.set($event)"
            />
          }
          @case ('products') {
            <hga-product-source-field
              [categories]="categoryChoices()"
              [rooms]="roomChoices()"
              [promotions]="promotionChoices()"
              [unavailable]="draft().unavailable.source"
              [unavailableProductIds]="draft().unavailable.productIds"
              [error]="errors()['source'] ?? ''"
              [loading]="loadingPicks()"
              [source]="source()"
              (sourceChange)="source.set($event)"
              [picks]="picks()"
              (picksChange)="picks.set($event)"
            />
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>מספר מוצרים בשורה</mat-label>
              <mat-select [value]="count()" (selectionChange)="count.set($event.value)">
                @for (n of counts; track n) {
                  <mat-option [value]="n">{{ n }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
          @default {
            <p class="muted">לאזור הזה אין הגדרות נוספות.</p>
          }
        }

        @if (problem()) {
          <p class="error" role="alert">{{ problem() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" class="cancel" (click)="ref.close()">ביטול</button>
        <button matButton="filled" type="submit" class="apply">אישור</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class HomeSectionDialog {
  protected readonly data = inject<HomeSectionDialogData>(MAT_DIALOG_DATA);
  protected readonly ref = inject<MatDialogRef<HomeSectionDialog, HomeDraft>>(MatDialogRef);
  private readonly catalog = inject(CatalogApi);

  protected readonly limits = CONTENT_LIMITS;
  protected readonly titleMax = CONTENT_LIMITS.title;
  protected readonly counts = HOME_PRODUCT_COUNTS;

  protected readonly draft = signal<HomeDraft>(this.data.draft);
  protected readonly title = signal(this.data.draft.titleHe ?? '');
  protected readonly bannerIds = signal<number[]>(
    this.data.draft.kind === 'hero' || this.data.draft.kind === 'banner_pair' ? [...this.data.draft.bannerIds] : [],
  );
  protected readonly categoryIds = signal<number[]>(
    this.data.draft.kind === 'categories' ? [...this.data.draft.categoryIds] : [],
  );
  protected readonly source = signal<ProductSource>(
    this.data.draft.kind === 'products' ? this.data.draft.source : { kind: 'bestsellers' },
  );
  protected readonly count = signal<HomeProductCount>(this.data.draft.kind === 'products' ? this.data.draft.count : 4);
  protected readonly picks = signal<RelatedPick[]>([]);
  protected readonly loadingPicks = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly problem = signal('');

  protected readonly kindLabel = computed(() => HOME_SECTION_LABELS_HE[this.draft().kind]);
  protected readonly titleHint = computed(() =>
    this.draft().kind === 'rooms'
      ? 'האזור הזה מציג כל חדר בשמו. הכותרת כאן משמשת רק ברשימה.'
      : 'מוצגת באתר מעל האזור, ובמסך הזה ברשימה.',
  );

  protected readonly bannerOptions = computed<IdOption[]>(() =>
    this.data.lookups.banners.map((b) => ({ id: b.id, label: b.nameHe })),
  );
  protected readonly categoryChoices = computed(() => categoryOptions(this.data.lookups.categories));
  protected readonly roomChoices = computed<IdOption[]>(() =>
    this.data.lookups.rooms.map((r) => ({ id: r.id, label: `${r.nameHe}${r.active ? '' : ' (מוסתר)'}` })),
  );
  protected readonly promotionChoices = computed(() => promotionOptions(this.data.lookups.promotions));

  constructor() {
    const d = this.data.draft;
    if (d.kind === 'products' && d.source.kind === 'manual') void this.loadPicks(d.source.productIds);
  }

  /** The names of the products already picked: one read each, a missing one keeps its id. */
  private async loadPicks(ids: number[]) {
    this.loadingPicks.set(true);
    const found = await Promise.allSettled(ids.map((id) => this.catalog.product(id)));
    // A pick added while this was loading stays; the loaded ones keep the saved order.
    const loaded = found.map((r, i): RelatedPick => {
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
    this.picks.set(loaded);
    this.loadingPicks.set(false);
  }

  protected submit(event: Event) {
    event.preventDefault();
    const base = this.draft();
    const titleHe = this.title().trim() || null;
    let next: HomeDraft;
    switch (base.kind) {
      case 'hero':
      case 'banner_pair':
        next = { ...base, titleHe, bannerIds: this.bannerIds() };
        break;
      case 'categories':
        next = { ...base, titleHe, categoryIds: this.categoryIds() };
        break;
      case 'products':
        next = { ...base, titleHe, source: this.source(), count: this.count() };
        break;
      default:
        next = { ...base, titleHe };
    }
    const errors = sectionProblems(next);
    this.errors.set(errors);
    this.problem.set(Object.keys(errors).length ? HOME_MESSAGES.fixBelow : '');
    if (Object.keys(errors).length) return;
    this.ref.close(next);
  }
}
