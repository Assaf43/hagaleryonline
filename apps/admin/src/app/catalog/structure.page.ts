import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { LucidePencil, LucidePlus, LucideTrash2 } from '@lucide/angular';
import type { AdminAttribute, AdminAttributeValue, AdminCategory, CatalogStructure } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import {
  AttributeDialog,
  CategoryDialog,
  RoomDialog,
  SynonymDialog,
  ValueDialog,
  type CategoryDialogData,
  type ValueDialogData,
} from './structure-dialogs';

const DIALOG = { width: '520px', maxWidth: '95vw' };

/**
 * Catalog structure (ADM-03, ADM-17): categories and their filters, rooms, closed value lists and
 * search synonyms. Everyone with catalog.view can look; changes need catalog.structure.
 */
@Component({
  selector: 'hga-structure-page',
  imports: [RouterLink, MatButtonModule, MatTabsModule, LucidePencil, LucidePlus, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>מבנה הקטלוג</h1>
    <p class="page-intro">
      קטגוריות, חדרים, רשימות הערכים לסינון ומילים נרדפות לחיפוש. שינוי כאן מופיע באתר מיד.
      @if (!canEdit()) {
        (צפייה בלבד, אין לכם הרשאה לשנות את המבנה)
      }
    </p>
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }

    @if (data(); as d) {
      <mat-tab-group mat-stretch-tabs="false" animationDuration="0ms">
        <!-- Categories -->
        <mat-tab label="קטגוריות">
          <div class="tab">
            @if (canEdit()) {
              <button matButton="filled" type="button" class="add" (click)="editCategory(null)">
                <svg lucidePlus></svg> קטגוריה
              </button>
            }
            <ul class="rows">
              @for (c of tree(); track c.category.id) {
                <li class="row" [class.child]="c.depth > 0" [class.hidden]="!c.category.active">
                  <span class="row-main">
                    <strong>{{ c.category.nameHe }}</strong>
                    <bdi dir="ltr" class="code">{{ c.category.slug }}</bdi>
                    @if (!c.category.active) {
                      <span class="badge">מוסתרת</span>
                    }
                  </span>
                  <span class="row-meta">
                    <a [routerLink]="['/catalog/products']" [queryParams]="{ categoryId: c.category.id }">
                      {{ c.category.productCount }} מוצרים
                    </a>
                    · מסננים: {{ attributeNames(c.category.attributeCodes) || (c.depth ? 'יורשת מהאב' : '—') }}
                  </span>
                  @if (canEdit()) {
                    <button
                      matIconButton
                      type="button"
                      [attr.aria-label]="'עריכת ' + c.category.nameHe"
                      (click)="editCategory(c.category)"
                    >
                      <svg lucidePencil></svg>
                    </button>
                  }
                </li>
              }
            </ul>
          </div>
        </mat-tab>

        <!-- Rooms -->
        <mat-tab label="חדרים">
          <div class="tab">
            @if (canEdit()) {
              <button matButton="filled" type="button" class="add" (click)="editRoom(null)">
                <svg lucidePlus></svg> חדר
              </button>
            }
            <ul class="rows">
              @for (r of d.rooms; track r.id) {
                <li class="row" [class.hidden]="!r.active">
                  <span class="row-main">
                    <strong>{{ r.nameHe }}</strong>
                    <bdi dir="ltr" class="code">{{ r.slug }}</bdi>
                    @if (!r.active) {
                      <span class="badge">לא פעיל</span>
                    }
                  </span>
                  <span class="row-meta">{{ r.productCount }} מוצרים</span>
                  @if (canEdit()) {
                    <button matIconButton type="button" [attr.aria-label]="'עריכת ' + r.nameHe" (click)="editRoom(r)">
                      <svg lucidePencil></svg>
                    </button>
                  }
                </li>
              }
            </ul>
          </div>
        </mat-tab>

        <!-- Closed value lists -->
        <mat-tab label="רשימות ערכים">
          <div class="tab">
            @if (canEdit()) {
              <button matButton="filled" type="button" class="add" (click)="editAttribute(null)">
                <svg lucidePlus></svg> רשימה
              </button>
            }
            @for (a of d.attributes; track a.id) {
              <section class="attribute">
                <header class="attribute-head">
                  <h2>{{ a.nameHe }}</h2>
                  <bdi dir="ltr" class="code">{{ a.code }}</bdi>
                  <span class="badge">{{ a.scope === 'product' ? 'ברמת מוצר' : 'ברמת וריאנט' }}</span>
                  @if (!a.filterable) {
                    <span class="badge">לא לסינון</span>
                  }
                  <span class="spacer"></span>
                  @if (canEdit()) {
                    <button matButton type="button" (click)="editAttribute(a)">עריכה</button>
                    <button matButton="tonal" type="button" (click)="editValue(a, null)">
                      <svg lucidePlus></svg> ערך
                    </button>
                  }
                </header>
                <ul class="chips">
                  @for (v of a.values; track v.id) {
                    <li class="chip">
                      @if (v.swatchHex) {
                        <span class="swatch" [style.background]="v.swatchHex"></span>
                      }
                      <span>{{ v.labelHe }}</span>
                      <span class="count" [attr.aria-label]="v.usageCount + ' שימושים'">{{ v.usageCount }}</span>
                      @if (canEdit()) {
                        <button
                          matIconButton
                          type="button"
                          class="chip-button"
                          [attr.aria-label]="'עריכת ' + v.labelHe"
                          (click)="editValue(a, v)"
                        >
                          <svg lucidePencil></svg>
                        </button>
                        @if (v.usageCount === 0) {
                          <button
                            matIconButton
                            type="button"
                            class="chip-button"
                            [attr.aria-label]="'מחיקת ' + v.labelHe"
                            (click)="deleteValue(a, v)"
                          >
                            <svg lucideTrash2></svg>
                          </button>
                        }
                      }
                    </li>
                  } @empty {
                    <li class="muted">אין ערכים עדיין.</li>
                  }
                </ul>
              </section>
            }
          </div>
        </mat-tab>

        <!-- Synonyms -->
        <mat-tab label="מילים נרדפות">
          <div class="tab">
            <p class="muted">כשלקוח מחפש מילה אחת מקבוצה, החיפוש מוצא גם את האחרות.</p>
            @if (canEdit()) {
              <button matButton="filled" type="button" class="add" (click)="editSynonym(null)">
                <svg lucidePlus></svg> קבוצה
              </button>
            }
            <ul class="rows">
              @for (s of d.synonyms; track s.id) {
                <li class="row">
                  <span class="row-main">{{ s.terms.join(' · ') }}</span>
                  @if (canEdit()) {
                    <button matIconButton type="button" aria-label="עריכת הקבוצה" (click)="editSynonym(s)">
                      <svg lucidePencil></svg>
                    </button>
                    <button matIconButton type="button" aria-label="מחיקת הקבוצה" (click)="deleteSynonym(s.id)">
                      <svg lucideTrash2></svg>
                    </button>
                  }
                </li>
              }
            </ul>
          </div>
        </mat-tab>
      </mat-tab-group>
    } @else if (!error()) {
      <p class="page-intro">טוען…</p>
    }
  `,
  styles: `
    .tab {
      padding-block: var(--space-4);
      display: grid;
      gap: var(--space-3);
    }

    .add {
      justify-self: start;
    }

    svg {
      inline-size: 18px;
      block-size: 18px;
    }

    .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-2);
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-3);
      padding: var(--space-2) var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }

    .row.child {
      margin-inline-start: var(--space-6);
    }

    .row.hidden {
      opacity: 0.7;
    }

    .row-main {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      min-inline-size: 0;
    }

    .row-meta,
    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .code {
      font-family: monospace;
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }

    .attribute {
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }

    .attribute-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
    }

    .attribute-head h2 {
      font-size: var(--font-h3);
      margin: 0;
    }

    .spacer {
      flex: 1;
    }

    .chips {
      list-style: none;
      margin: var(--space-2) 0 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      padding-inline: var(--space-3) var(--space-1);
      min-block-size: 36px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pill);
      background: var(--color-bg);
      font-size: var(--font-small);
    }

    .swatch {
      inline-size: 14px;
      block-size: 14px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--color-border-strong);
    }

    .count {
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }

    .chip-button svg {
      inline-size: 16px;
      block-size: 16px;
    }
  `,
})
export class StructurePage implements OnInit {
  private readonly api = inject(CatalogApi);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  protected readonly data = signal<CatalogStructure | null>(null);
  protected readonly error = signal('');
  protected readonly canEdit = computed(() => this.auth.me()?.permissions.includes('catalog.structure') ?? false);

  /** Categories in tree order, with their depth. */
  protected readonly tree = computed(() => {
    const all = this.data()?.categories ?? [];
    const result: { category: AdminCategory; depth: number }[] = [];
    const walk = (parentId: number | null, depth: number) => {
      for (const c of all.filter((x) => x.parentId === parentId)) {
        result.push({ category: c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return result;
  });

  ngOnInit() {
    void this.reload();
  }

  attributeNames(codes: string[]): string {
    const attributes = this.data()?.attributes ?? [];
    return codes.map((code) => attributes.find((a) => a.code === code)?.nameHe ?? code).join(', ');
  }

  editCategory(category: AdminCategory | null) {
    const d = this.data()!;
    this.open<CategoryDialogData>(CategoryDialog, { category, categories: d.categories, attributes: d.attributes });
  }

  editRoom(room: CatalogStructure['rooms'][number] | null) {
    this.open(RoomDialog, room);
  }

  editAttribute(attribute: AdminAttribute | null) {
    this.open(AttributeDialog, attribute);
  }

  editValue(attribute: AdminAttribute, value: AdminAttributeValue | null) {
    this.open<ValueDialogData>(ValueDialog, { attribute, value });
  }

  editSynonym(synonym: CatalogStructure['synonyms'][number] | null) {
    this.open(SynonymDialog, synonym);
  }

  async deleteValue(attribute: AdminAttribute, value: AdminAttributeValue) {
    if (!confirm(`למחוק את "${value.labelHe}" מהרשימה ${attribute.nameHe}?`)) return;
    await this.run(() => this.api.deleteValue(attribute.id, value.id), 'הערך נמחק');
  }

  async deleteSynonym(id: number) {
    if (!confirm('למחוק את קבוצת המילים הנרדפות?')) return;
    await this.run(() => this.api.deleteSynonym(id), 'הקבוצה נמחקה');
  }

  private open<T>(component: unknown, data: T) {
    this.dialog
      .open(component as never, { ...DIALOG, data })
      .afterClosed()
      .subscribe((saved) => {
        if (!saved) return;
        this.snack.open('נשמר', undefined, { duration: 2500 });
        void this.reload();
      });
  }

  private async run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      this.snack.open(done, undefined, { duration: 2500 });
      await this.reload();
    } catch (e) {
      this.snack.open(errorMessage(e), 'סגירה', { duration: 6000 });
    }
  }

  private async reload() {
    try {
      this.data.set(await this.api.structure());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
