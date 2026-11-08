import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type {
  AdminAttribute,
  AdminAttributeValue,
  AdminCategory,
  AdminRoom,
  AdminSynonym,
  AttributeScope,
} from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { categoryOptions, toSlug } from './catalog-format';

const DIALOG_IMPORTS = [
  FormsModule,
  MatButtonModule,
  MatCheckboxModule,
  MatDialogModule,
  MatFormFieldModule,
  MatInputModule,
  MatSelectModule,
];

/** Shared save flow: busy flag, Hebrew error, close with true on success. */
abstract class SaveDialog {
  protected readonly api = inject(CatalogApi);
  private readonly ref = inject(MatDialogRef<SaveDialog, boolean>);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      this.ref.close(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

const ACTIONS = `
  @if (error()) {
    <p class="form-error" role="alert">{{ error() }}</p>
  }
  </mat-dialog-content>
  <mat-dialog-actions align="end">
    <button matButton type="button" mat-dialog-close>ביטול</button>
    <button matButton="filled" type="submit" [disabled]="busy()">שמירה</button>
  </mat-dialog-actions>
`;

const SLUG_FIELD = `
  <mat-form-field>
    <mat-label>כתובת באתר</mat-label>
    <input matInput name="slug" dir="ltr" required [(ngModel)]="slug" (blur)="slug = toSlug(slug)" />
    <mat-hint>אותיות באנגלית, ספרות ומקפים בלבד</mat-hint>
  </mat-form-field>
`;

// ---------- Category ----------

export interface CategoryDialogData {
  category: AdminCategory | null;
  categories: AdminCategory[];
  attributes: AdminAttribute[];
}

/** A furniture type: name, address, place in the tree, and the filters it offers (category_attributes). */
@Component({
  selector: 'hga-category-dialog',
  imports: DIALOG_IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.category ? 'עריכת ' + data.category.nameHe : 'קטגוריה חדשה' }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>שם</mat-label>
          <input matInput name="nameHe" required maxlength="80" [(ngModel)]="nameHe" />
        </mat-form-field>
        ${SLUG_FIELD}
        <mat-form-field>
          <mat-label>קטגוריית אב</mat-label>
          <mat-select name="parentId" [(ngModel)]="parentId">
            <mat-option [value]="null">ללא (סוג רהיט ראשי בתפריט)</mat-option>
            @for (c of parents; track c.id) {
              <mat-option [value]="c.id">{{ c.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>מסננים ואפשרויות</mat-label>
          <mat-select multiple name="attributeCodes" [(ngModel)]="attributeCodes">
            @for (a of data.attributes; track a.id) {
              <mat-option [value]="a.code">{{ a.nameHe }}</mat-option>
            }
          </mat-select>
          <mat-hint>תת-קטגוריות יורשות את המסננים של קטגוריית האב</mat-hint>
        </mat-form-field>
        <mat-form-field>
          <mat-label>סדר</mat-label>
          <input matInput type="number" min="0" name="sortOrder" [(ngModel)]="sortOrder" />
        </mat-form-field>
        <mat-checkbox name="active" [(ngModel)]="active">מוצגת באתר</mat-checkbox>
        @if (data.category && !active && data.category.productCount) {
          <p class="dialog-note">הסתרה תוריד מהאתר גם את {{ data.category.productCount }} המוצרים שבה.</p>
        }
        ${ACTIONS}
    </form>
  `,
})
export class CategoryDialog extends SaveDialog {
  protected readonly data = inject<CategoryDialogData>(MAT_DIALOG_DATA);
  protected readonly toSlug = toSlug;
  private readonly c = this.data.category;
  protected nameHe = this.c?.nameHe ?? '';
  protected slug = this.c?.slug ?? '';
  protected parentId = this.c?.parentId ?? null;
  protected attributeCodes = [...(this.c?.attributeCodes ?? [])];
  protected sortOrder = this.c?.sortOrder ?? this.data.categories.length;
  protected active = this.c?.active ?? true;
  /** A category cannot move under itself; the API also refuses its own sub-categories. */
  protected readonly parents = categoryOptions(this.data.categories).filter((o) => o.id !== this.c?.id);

  save() {
    const input = {
      nameHe: this.nameHe,
      slug: toSlug(this.slug),
      parentId: this.parentId,
      // Keep the order the filters are listed in the attribute list.
      attributeCodes: this.data.attributes.map((a) => a.code).filter((code) => this.attributeCodes.includes(code)),
      sortOrder: this.sortOrder,
      active: this.active,
    };
    return this.run(() => this.api.saveCategory(this.c?.id ?? null, input));
  }
}

// ---------- Room ----------

/** A room in the main menu (decision 44). It shows on the site once it has active products. */
@Component({
  selector: 'hga-room-dialog',
  imports: DIALOG_IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ room ? 'עריכת ' + room.nameHe : 'חדר חדש' }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>שם</mat-label>
          <input matInput name="nameHe" required maxlength="80" [(ngModel)]="nameHe" />
        </mat-form-field>
        ${SLUG_FIELD}
        <mat-form-field>
          <mat-label>סדר בתפריט</mat-label>
          <input matInput type="number" min="0" name="sortOrder" [(ngModel)]="sortOrder" />
        </mat-form-field>
        <mat-checkbox name="active" [(ngModel)]="active">פעיל</mat-checkbox>
        <p class="dialog-note">חדר מופיע בתפריט האתר רק כשיש בו מוצרים מוצגים.</p>
        ${ACTIONS}
    </form>
  `,
})
export class RoomDialog extends SaveDialog {
  protected readonly room = inject<AdminRoom | null>(MAT_DIALOG_DATA);
  protected readonly toSlug = toSlug;
  protected nameHe = this.room?.nameHe ?? '';
  protected slug = this.room?.slug ?? '';
  protected sortOrder = this.room?.sortOrder ?? 0;
  protected active = this.room?.active ?? true;

  save() {
    const input = { nameHe: this.nameHe, slug: toSlug(this.slug), sortOrder: this.sortOrder, active: this.active };
    return this.run(() => this.api.saveRoom(this.room?.id ?? null, input));
  }
}

// ---------- Attribute (a closed list) ----------

/** A closed list such as color or style (ADM-03). The code and the level are fixed once created. */
@Component({
  selector: 'hga-attribute-dialog',
  imports: DIALOG_IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ attribute ? 'עריכת ' + attribute.nameHe : 'רשימה חדשה' }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>שם</mat-label>
          <input matInput name="nameHe" required maxlength="80" [(ngModel)]="nameHe" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>קוד באנגלית</mat-label>
          <input
            matInput
            name="code"
            dir="ltr"
            required
            [disabled]="!!attribute"
            [(ngModel)]="code"
            (blur)="code = toSlug(code)"
          />
          <mat-hint>מופיע בכתובות הסינון באתר, ולכן לא משתנה אחרי היצירה</mat-hint>
        </mat-form-field>
        <mat-form-field>
          <mat-label>נבחר ברמת</mat-label>
          <mat-select name="scope" [(ngModel)]="scope" [disabled]="!!attribute">
            <mat-option value="product">מוצר (למשל סגנון, רכות)</mat-option>
            <mat-option value="variant">וריאנט (למשל צבע, בד, צד שזלונג)</mat-option>
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>סדר</mat-label>
          <input matInput type="number" min="0" name="sortOrder" [(ngModel)]="sortOrder" />
        </mat-form-field>
        <mat-checkbox name="filterable" [(ngModel)]="filterable">משמש לסינון באתר</mat-checkbox>
        ${ACTIONS}
    </form>
  `,
})
export class AttributeDialog extends SaveDialog {
  protected readonly attribute = inject<AdminAttribute | null>(MAT_DIALOG_DATA);
  protected readonly toSlug = toSlug;
  protected nameHe = this.attribute?.nameHe ?? '';
  protected code = this.attribute?.code ?? '';
  protected scope: AttributeScope = this.attribute?.scope ?? 'product';
  protected sortOrder = this.attribute?.sortOrder ?? 0;
  protected filterable = this.attribute?.filterable ?? true;

  save() {
    const input = {
      nameHe: this.nameHe,
      code: toSlug(this.code),
      scope: this.scope,
      sortOrder: this.sortOrder,
      filterable: this.filterable,
    };
    return this.run(() => this.api.saveAttribute(this.attribute?.id ?? null, input));
  }
}

// ---------- Value in a closed list ----------

export interface ValueDialogData {
  attribute: AdminAttribute;
  value: AdminAttributeValue | null;
}

/** One value of a closed list, with a swatch color for colors. */
@Component({
  selector: 'hga-value-dialog',
  imports: DIALOG_IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.value ? 'עריכת ' + data.value.labelHe : 'ערך חדש ב' + data.attribute.nameHe }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>שם בעברית</mat-label>
          <input matInput name="labelHe" required maxlength="80" [(ngModel)]="labelHe" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>קוד באנגלית</mat-label>
          <input
            matInput
            name="code"
            dir="ltr"
            required
            [disabled]="!!data.value"
            [(ngModel)]="code"
            (blur)="code = toSlug(code)"
          />
          <mat-hint>למשל beige או boucle. לא משתנה אחרי היצירה</mat-hint>
        </mat-form-field>
        <div class="swatch-field">
          <mat-checkbox name="hasSwatch" [(ngModel)]="hasSwatch">דוגמית צבע</mat-checkbox>
          @if (hasSwatch) {
            <input type="color" name="swatch" aria-label="בחירת צבע לדוגמית" [(ngModel)]="swatchHex" />
            <bdi dir="ltr">{{ swatchHex }}</bdi>
          }
        </div>
        <mat-form-field>
          <mat-label>סדר</mat-label>
          <input matInput type="number" min="0" name="sortOrder" [(ngModel)]="sortOrder" />
        </mat-form-field>
        ${ACTIONS}
    </form>
  `,
  styles: `
    .swatch-field {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-block-end: var(--space-3);
    }

    input[type='color'] {
      inline-size: 48px;
      block-size: 32px;
      padding: 0;
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: none;
    }
  `,
})
export class ValueDialog extends SaveDialog {
  protected readonly data = inject<ValueDialogData>(MAT_DIALOG_DATA);
  protected readonly toSlug = toSlug;
  private readonly v = this.data.value;
  protected labelHe = this.v?.labelHe ?? '';
  protected code = this.v?.code ?? '';
  protected hasSwatch = this.v ? this.v.swatchHex !== null : this.data.attribute.code === 'color';
  protected swatchHex = this.v?.swatchHex ?? '#c8b8a0';
  protected sortOrder = this.v?.sortOrder ?? this.data.attribute.values.length;

  save() {
    const input = {
      labelHe: this.labelHe,
      code: toSlug(this.code),
      swatchHex: this.hasSwatch ? this.swatchHex : null,
      sortOrder: this.sortOrder,
    };
    return this.run(() => this.api.saveValue(this.data.attribute.id, this.v?.id ?? null, input));
  }
}

// ---------- Synonym group ----------

/** Words customers use for the same thing (decision 47), e.g. ספה, sofa, כורסה, כורסא. */
@Component({
  selector: 'hga-synonym-dialog',
  imports: DIALOG_IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ synonym ? 'עריכת מילים נרדפות' : 'מילים נרדפות חדשות' }}</h2>
    <form (ngSubmit)="save()">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>מילים, מופרדות בפסיק</mat-label>
          <textarea matInput name="terms" rows="3" required [(ngModel)]="terms"></textarea>
          <mat-hint>חיפוש של כל אחת מהמילים ימצא גם את האחרות. לפחות שתי מילים.</mat-hint>
        </mat-form-field>
        ${ACTIONS}
    </form>
  `,
})
export class SynonymDialog extends SaveDialog {
  protected readonly synonym = inject<AdminSynonym | null>(MAT_DIALOG_DATA);
  protected terms = this.synonym?.terms.join(', ') ?? '';

  save() {
    const terms = this.terms
      .split(/[,،\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return this.run(() => this.api.saveSynonym(this.synonym?.id ?? null, terms));
  }
}
