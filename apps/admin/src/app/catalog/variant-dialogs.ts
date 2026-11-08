import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { LucidePlus, LucideX } from '@lucide/angular';
import type { AdminAttribute, FulfillmentMode } from '@hg/models';
import { FULFILLMENT_LABEL } from './catalog-format';

export interface SizeRow {
  widthCm: number | null;
  depthCm: number | null;
  heightCm: number | null;
  /** ₪ */
  price: number | null;
}

export interface GeneratorData {
  /** Variant attributes of the product's category (color, fabric, chaise side...). */
  attributes: AdminAttribute[];
}

export interface GeneratorResult {
  sizes: SizeRow[];
  /** attribute code → chosen value codes */
  options: Record<string, string[]>;
  stock: number;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
}

const FULFILLMENTS = Object.entries(FULFILLMENT_LABEL) as [FulfillmentMode, string][];

/**
 * Variant generator (approved proposal 1): choose sizes and options, get every combination.
 * Existing combinations are kept as they are; prices are then fine-tuned in the table.
 */
@Component({
  selector: 'hga-variant-generator-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    LucidePlus,
    LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>יצירת וריאנטים</h2>
    <form (ngSubmit)="done()">
      <mat-dialog-content class="dialog-form">
        <p class="dialog-note">
          בוחרים מידות ואפשרויות, ונוצרת שורה לכל צירוף. צירופים שכבר קיימים לא ישתנו. אחר כך אפשר לערוך כל שורה.
        </p>

        <fieldset class="permissions">
          <legend>מידות ומחיר (ס"מ, ₪ כולל מע"מ)</legend>
          @for (size of sizes(); track $index; let i = $index) {
            <div class="size-row">
              <mat-form-field>
                <mat-label>רוחב</mat-label>
                <input matInput type="number" min="1" [name]="'w' + i" [(ngModel)]="size.widthCm" required />
              </mat-form-field>
              <mat-form-field>
                <mat-label>עומק</mat-label>
                <input matInput type="number" min="1" [name]="'d' + i" [(ngModel)]="size.depthCm" required />
              </mat-form-field>
              <mat-form-field>
                <mat-label>גובה</mat-label>
                <input matInput type="number" min="1" [name]="'h' + i" [(ngModel)]="size.heightCm" required />
              </mat-form-field>
              <mat-form-field>
                <mat-label>מחיר</mat-label>
                <input matInput type="number" min="1" [name]="'p' + i" [(ngModel)]="size.price" required />
              </mat-form-field>
              <button
                matIconButton
                type="button"
                aria-label="הסרת מידה"
                [disabled]="sizes().length === 1"
                (click)="removeSize(i)"
              >
                <svg lucideX></svg>
              </button>
            </div>
          }
          <div>
            <button matButton type="button" (click)="addSize()"><svg lucidePlus></svg> מידה נוספת</button>
          </div>
        </fieldset>

        @for (a of data.attributes; track a.id) {
          <mat-form-field>
            <mat-label>{{ a.nameHe }}</mat-label>
            <mat-select multiple [name]="'opt-' + a.code" [(ngModel)]="options[a.code]">
              @for (v of a.values; track v.id) {
                <mat-option [value]="v.code">
                  @if (v.swatchHex) {
                    <span class="swatch" [style.background]="v.swatchHex"></span>
                  }
                  {{ v.labelHe }}
                </mat-option>
              }
            </mat-select>
          </mat-form-field>
        }

        <div class="size-row">
          <mat-form-field>
            <mat-label>מלאי לכל שורה</mat-label>
            <input matInput type="number" min="0" name="stock" [(ngModel)]="stock" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>מצב אספקה</mat-label>
            <mat-select name="fulfillment" [(ngModel)]="fulfillment">
              @for (f of fulfillments; track f[0]) {
                <mat-option [value]="f[0]">{{ f[1] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>זמן אספקה (ימי עסקים)</mat-label>
            <input matInput type="number" min="0" name="lead" [(ngModel)]="leadTimeDays" />
          </mat-form-field>
        </div>
        <p class="dialog-note" aria-live="polite">ייווצרו עד {{ count() }} שורות.</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>ביטול</button>
        <button matButton="filled" type="submit" [disabled]="!valid()">יצירה</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .size-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)) auto;
      gap: 0 var(--space-2);
      align-items: start;
    }

    .swatch {
      display: inline-block;
      inline-size: 14px;
      block-size: 14px;
      border-radius: var(--radius-pill);
      border: var(--border-width) solid var(--color-border-strong);
      vertical-align: middle;
      margin-inline-end: var(--space-1);
    }
  `,
})
export class VariantGeneratorDialog {
  protected readonly data = inject<GeneratorData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<VariantGeneratorDialog, GeneratorResult>);
  protected readonly fulfillments = FULFILLMENTS;
  protected readonly sizes = signal<SizeRow[]>([{ widthCm: null, depthCm: null, heightCm: null, price: null }]);
  protected options: Record<string, string[]> = Object.fromEntries(this.data.attributes.map((a) => [a.code, []]));
  protected stock = 0;
  protected fulfillment: FulfillmentMode = 'made_to_order';
  protected leadTimeDays = 30;

  addSize() {
    const last = this.sizes().at(-1)!;
    this.sizes.update((s) => [...s, { ...last, widthCm: null, price: null }]);
  }

  removeSize(index: number) {
    this.sizes.update((s) => s.filter((_, i) => i !== index));
  }

  count(): number {
    return Object.values(this.options).reduce((n, values) => n * Math.max(1, values.length), this.sizes().length);
  }

  valid(): boolean {
    return this.sizes().every((s) => [s.widthCm, s.depthCm, s.heightCm, s.price].every((n) => n !== null && n > 0));
  }

  done() {
    if (!this.valid()) return;
    this.ref.close({
      sizes: this.sizes(),
      options: this.options,
      stock: this.stock,
      fulfillment: this.fulfillment,
      leadTimeDays: this.leadTimeDays,
    });
  }
}

export interface BulkEditResult {
  /** ₪, replaces the price */
  price?: number;
  /** % up (positive) or down (negative) */
  pricePercent?: number;
  /** ₪; 0 removes the "before" price */
  compareAtPrice?: number;
  stock?: number;
  fulfillment?: FulfillmentMode;
  leadTimeDays?: number;
  active?: boolean;
}

/** Change several variants at once (approved proposal 1): only the fields that were filled in are applied. */
@Component({
  selector: 'hga-variant-bulk-dialog',
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>עריכה של {{ count }} שורות</h2>
    <form (ngSubmit)="done()">
      <mat-dialog-content class="dialog-form">
        <p class="dialog-note">ממלאים רק את מה שרוצים לשנות. שדה ריק נשאר כמו שהוא.</p>
        <mat-form-field>
          <mat-label>מחיר חדש (₪)</mat-label>
          <input matInput type="number" min="1" name="price" [(ngModel)]="price" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>או: שינוי מחיר באחוזים (למשל 10 או ‎-5)</mat-label>
          <input matInput type="number" name="pct" [(ngModel)]="pricePercent" [disabled]="price !== null" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>מחיר לפני הנחה (₪, 0 מבטל)</mat-label>
          <input matInput type="number" min="0" name="compare" [(ngModel)]="compareAtPrice" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>מלאי</mat-label>
          <input matInput type="number" min="0" name="stock" [(ngModel)]="stock" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>מצב אספקה</mat-label>
          <mat-select name="fulfillment" [(ngModel)]="fulfillment">
            <mat-option [value]="null">ללא שינוי</mat-option>
            @for (f of fulfillments; track f[0]) {
              <mat-option [value]="f[0]">{{ f[1] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>זמן אספקה (ימי עסקים)</mat-label>
          <input matInput type="number" min="0" name="lead" [(ngModel)]="leadTimeDays" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>זמינות</mat-label>
          <mat-select name="active" [(ngModel)]="active">
            <mat-option [value]="null">ללא שינוי</mat-option>
            <mat-option [value]="true">פעיל</mat-option>
            <mat-option [value]="false">לא פעיל</mat-option>
          </mat-select>
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>ביטול</button>
        <button matButton="filled" type="submit">החלה</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class VariantBulkDialog {
  protected readonly count = inject<number>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<VariantBulkDialog, BulkEditResult>);
  protected readonly fulfillments = FULFILLMENTS;
  protected price: number | null = null;
  protected pricePercent: number | null = null;
  protected compareAtPrice: number | null = null;
  protected stock: number | null = null;
  protected fulfillment: FulfillmentMode | null = null;
  protected leadTimeDays: number | null = null;
  protected active: boolean | null = null;

  done() {
    const result: BulkEditResult = {};
    if (this.price !== null && this.price > 0) result.price = this.price;
    else if (this.pricePercent) result.pricePercent = this.pricePercent;
    if (this.compareAtPrice !== null) result.compareAtPrice = this.compareAtPrice;
    if (this.stock !== null) result.stock = this.stock;
    if (this.fulfillment) result.fulfillment = this.fulfillment;
    if (this.leadTimeDays !== null) result.leadTimeDays = this.leadTimeDays;
    if (this.active !== null) result.active = this.active;
    this.ref.close(result);
  }
}
