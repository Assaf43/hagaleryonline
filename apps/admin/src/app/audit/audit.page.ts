import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_LABELS,
  ORDER_STATUS_LABELS_HE,
  type AuditEntry,
  type AuditPage,
} from '@hg/models';
import { errorMessage } from '../core/errors';
import { UsersApi } from '../core/users.api';

/** Entries recorded readable as they are: Hebrew keys and display values (shipping price list, zones, promotions). */
const READABLE = new Set([
  'shipping',
  'shipping_zone',
  'promotion',
  'site_content',
  'announcement',
  'info_page',
  'faq_group',
  'banner',
  'content_image',
  'home_page',
  'landing_page',
]);

/** Prices are stored in agorot; show them in shekels. */
const MONEY = new Set(['price', 'compareAtPrice', 'memberPrice']);
const ILS = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const FIELDS: Record<string, string> = {
  name: 'שם',
  email: 'אימייל',
  status: 'מצב',
  template: 'תבנית',
  extraPermissions: 'הרשאות שנוספו',
  removedPermissions: 'הרשאות שהוסרו',
  modelName: 'שם דגם',
  nameHe: 'שם',
  slug: 'כתובת באתר',
  descriptionHe: 'תיאור',
  categoryId: 'קטגוריה',
  roomIds: 'חדרים',
  attributes: 'מאפיינים',
  countryOfOrigin: 'ארץ ייצור',
  warrantyMonths: 'אחריות (חודשים)',
  careHe: 'הוראות טיפול',
  requiresAssembly: 'דורש הרכבה',
  active: 'מוצג / פעיל',
  sortOrder: 'סדר',
  sku: 'מק"ט',
  price: 'מחיר',
  compareAtPrice: 'מחיר לפני הנחה',
  memberPrice: 'מחיר מועדון',
  stock: 'מלאי',
  fulfillment: 'מצב אספקה',
  leadTimeDays: 'זמן אספקה (ימים)',
  productionDays: 'ימי ייצור',
  expectedAt: 'תאריך הגעה',
  widthCm: 'רוחב',
  depthCm: 'עומק',
  heightCm: 'גובה',
  weightKg: 'משקל',
  seatHeightCm: 'גובה מושב',
  seatDepthCm: 'עומק מושב',
  chaiseWidthCm: 'רוחב שזלונג',
  chaiseDepthCm: 'עומק שזלונג',
  options: 'אפשרויות',
  parentId: 'קטגוריית אב',
  attributeCodes: 'מסננים',
  labelHe: 'שם בעברית',
  swatchHex: 'צבע דוגמית',
  filterable: 'לסינון',
  terms: 'מילים',
  color: 'צבע התמונה',
  kind: 'סוג תמונה',
  altHe: 'תיאור התמונה',
  order: 'סדר התמונות',
  slot: 'חלון אספקה',
};

/** Who changed what and when (ADM-11, decision 54). */
@Component({
  selector: 'hga-audit-page',
  imports: [DatePipe, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>יומן שינויים</h1>
    <p class="page-intro">
      כל שינוי במשתמשים, בהרשאות, בהתחברויות, במוצרים, במחירים, במלאי ובמבנה הקטלוג. נשמר שנתיים.
    </p>
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }
    @if (data(); as d) {
      <ul class="audit-list">
        @for (entry of d.items; track entry.id) {
          <li class="audit-item">
            <p class="audit-head">
              <strong>{{ actionLabel(entry.action) }}</strong>
              <span class="muted"
                ><bdi>{{ entry.createdAt | date: 'd.M.yyyy HH:mm' }}</bdi></span
              >
            </p>
            <p class="muted">
              {{ entry.actor ? 'על ידי ' + entry.actor.name : 'פעולת מערכת' }}
              @if (entry.entityId) {
                · {{ entityLabel(entry.entityType) }}:
                {{ entry.entityLabel ?? '#' + entry.entityId }}
              }
            </p>
            @for (change of changes(entry); track change.field) {
              <p class="audit-change">
                {{ change.label }}:
                <span class="before"
                  ><bdi>{{ change.before }}</bdi></span
                >
                ←
                <span class="after"
                  ><bdi>{{ change.after }}</bdi></span
                >
              </p>
            }
          </li>
        } @empty {
          <li class="muted">עדיין אין רשומות.</li>
        }
      </ul>
      @if (d.total > d.pageSize) {
        <div class="pager">
          <button matButton="outlined" type="button" [disabled]="d.page === 1" (click)="go(d.page - 1)">הקודם</button>
          <span class="muted">עמוד {{ d.page }} מתוך {{ pages(d) }}</span>
          <button matButton="outlined" type="button" [disabled]="d.page >= pages(d)" (click)="go(d.page + 1)">
            הבא
          </button>
        </div>
      }
    }
  `,
  styles: `
    .audit-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: var(--space-2);
    }

    .audit-item {
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      display: grid;
      gap: var(--space-1);
    }

    .audit-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .audit-change {
      font-size: var(--font-small);
    }

    .before {
      color: var(--color-text-secondary);
      text-decoration: line-through;
    }

    .pager {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      margin-block-start: var(--space-4);
    }
  `,
})
export class AuditPageComponent implements OnInit {
  private readonly api = inject(UsersApi);
  protected readonly data = signal<AuditPage | null>(null);
  protected readonly error = signal('');

  ngOnInit() {
    void this.go(1);
  }

  async go(page: number) {
    try {
      this.data.set(await this.api.audit(page));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  entityLabel(type: string): string {
    return (AUDIT_ENTITY_LABELS as Record<string, string>)[type] ?? type;
  }

  actionLabel(action: string): string {
    return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
  }

  pages(d: AuditPage): number {
    return Math.ceil(d.total / d.pageSize);
  }

  /** Fields that differ between before and after (only changed fields are recorded for catalog entries). */
  changes(entry: AuditEntry): { field: string; label: string; before: string; after: string }[] {
    const before = (entry.before ?? {}) as Record<string, unknown>;
    const after = (entry.after ?? {}) as Record<string, unknown>;
    if (READABLE.has(entry.entityType)) {
      // Also for a create or delete: what the zone held.
      return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .map((key) => ({ field: key, label: key, before: show(key, before[key]), after: show(key, after[key]) }));
    }
    if (!entry.before || !entry.after) return [];
    return Object.keys(FIELDS)
      .filter(
        (field) =>
          (field in before || field in after) && JSON.stringify(before[field]) !== JSON.stringify(after[field]),
      )
      .map((field) => ({
        field,
        label: FIELDS[field],
        before: show(field, before[field], entry.entityType),
        after: show(field, after[field], entry.entityType),
      }));
  }
}

function show(field: string, value: unknown, entityType?: string): string {
  if (value == null || value === '') return '—';
  // An order's status is recorded as its code; show the name the orders screen uses.
  if (entityType === 'order' && field === 'status' && typeof value === 'string') {
    return (ORDER_STATUS_LABELS_HE as Record<string, string>)[value] ?? value;
  }
  if (field === 'slot' && typeof value === 'object') return slotText(value as Record<string, unknown>);
  if (MONEY.has(field) && typeof value === 'number') return ILS.format(value / 100);
  // A description is HTML and can be long: say it changed rather than print it.
  if (field === 'descriptionHe' || field === 'תוכן' || field === 'טקסט משלוח' || /^תשובה \d+$/.test(field)) {
    return '(טקסט)';
  }
  if (typeof value === 'boolean') return value ? 'כן' : 'לא';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') {
    return (
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('/') : String(v)}`)
        .join(', ') || '—'
    );
  }
  return String(value);
}

/** "2026-11-17 09:00–13:00" (+ the note, when there is one). */
function slotText(slot: Record<string, unknown>): string {
  const text = `${slot['date'] ?? ''} ${slot['windowFrom'] ?? ''}–${slot['windowTo'] ?? ''}`.trim();
  return slot['note'] ? `${text} (${String(slot['note'])})` : text;
}
