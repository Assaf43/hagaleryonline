import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { LucideDownload, LucideFileSpreadsheet, LucideUpload } from '@lucide/angular';
import type { ImportIssue, ImportIssueCode, ImportReport } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { catalogIssueText, errorMessage } from '../core/errors';

const ISSUES: Record<ImportIssueCode, string> = {
  bad_file: 'הקובץ לא נפתח. שמרו אותו כקובץ Excel ‏(.xlsx) ונסו שוב.',
  missing_column: 'חסרה עמודה. התחילו מהתבנית או מקובץ ייצוא.',
  no_rows: 'אין בקובץ שורות מוצרים (שורת הדוגמה לא נספרת).',
  too_many_rows: 'יותר מדי שורות בקובץ אחד. חלקו לכמה קבצים.',
  required: 'חסר ערך',
  number: 'צריך מספר',
  date: 'צריך תאריך, למשל 31/12/2026',
  yes_no: 'צריך "כן" או "לא"',
  not_in_list: 'הערך לא ברשימה. בחרו מהרשימה הנפתחת',
  mixed_values: 'ערך שונה משורה אחרת של אותו דגם',
  duplicate_sku: 'המק"ט מופיע בקובץ יותר מפעם אחת',
  sku_taken: 'המק"ט שייך לדגם אחר',
  rejected: 'הערך לא תקין',
};

/**
 * Excel import and export (ADM-09, decisions 56–57). The file is checked first; nothing is saved
 * until it is clean and the user confirms the summary.
 */
@Component({
  selector: 'hga-excel-page',
  imports: [RouterLink, MatButtonModule, LucideDownload, LucideFileSpreadsheet, LucideUpload],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>ייבוא וייצוא Excel</h1>
    <p class="page-intro">
      להזנה ולעדכון של הרבה מוצרים בבת אחת. תמונות ותיאורים מוסיפים בטופס המוצר. הייבוא רק מוסיף ומעדכן, ולא מוחק או
      מסתיר מוצרים שלא מופיעים בקובץ.
    </p>

    <section class="panel">
      <h2>1. הורדה</h2>
      <p class="muted">
        תבנית ריקה למוצרים חדשים, או ייצוא של כל הקטלוג באותה תבנית, כדי לעדכן מחירים ומלאי ולהעלות בחזרה.
      </p>
      <div class="actions">
        <button matButton="outlined" type="button" [disabled]="busy()" (click)="download('template')">
          <svg lucideDownload></svg> תבנית ריקה
        </button>
        <button matButton="outlined" type="button" [disabled]="busy()" (click)="download('export')">
          <svg lucideFileSpreadsheet></svg> ייצוא הקטלוג
        </button>
      </div>
    </section>

    <section class="panel">
      <h2>2. העלאה ובדיקה</h2>
      <p class="muted">הקובץ נבדק כולו. אם יש שגיאות, שום דבר לא נשמר, ומקבלים רשימה לפי שורה ועמודה.</p>
      <div class="actions">
        <label class="file-button" [class.disabled]="busy()">
          <svg lucideUpload></svg>
          {{ file() ? 'קובץ אחר' : 'בחירת קובץ' }}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            [disabled]="busy()"
            (change)="choose($event)"
          />
        </label>
        @if (file(); as f) {
          <span class="file-name"
            ><bdi>{{ f.name }}</bdi></span
          >
        }
      </div>
      @if (busy()) {
        <p class="muted" role="status">{{ step() === 'import' ? 'שומר…' : 'בודק את הקובץ…' }}</p>
      }
      @if (error()) {
        <p class="form-error" role="alert">{{ error() }}</p>
      }
    </section>

    @if (report(); as r) {
      @if (r.errors.length) {
        <section class="panel" aria-labelledby="errors-title">
          <h2 id="errors-title" class="bad">
            {{ r.errors.length === 1 ? 'נמצאה בעיה אחת' : 'נמצאו ' + r.errors.length + ' בעיות' }}. שום דבר לא נשמר.
          </h2>
          <p class="muted">מתקנים בקובץ, שומרים ומעלים שוב.</p>
          <div class="table-scroll" tabindex="0" role="region" aria-label="רשימת הבעיות">
            <table class="issues">
              <thead>
                <tr>
                  <th>שורה</th>
                  <th>עמודה</th>
                  <th>הבעיה</th>
                  <th>ערך</th>
                </tr>
              </thead>
              <tbody>
                @for (issue of r.errors; track $index) {
                  <tr>
                    <td>{{ issue.row ?? '—' }}</td>
                    <td>{{ issue.column ?? '—' }}</td>
                    <td>{{ issueText(issue) }}</td>
                    <td>
                      <bdi>{{ issue.value ?? '' }}</bdi>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else {
        <section class="panel" aria-labelledby="summary-title">
          <h2 id="summary-title" [class.good]="r.applied">
            {{ r.applied ? 'הייבוא הושלם' : 'הקובץ תקין. זה מה שיקרה:' }}
          </h2>
          <ul class="summary">
            <li>{{ r.summary.rows }} שורות בקובץ</li>
            <li>{{ r.summary.productsCreated }} דגמים חדשים (יישמרו מוסתרים מהאתר)</li>
            <li>{{ r.summary.productsUpdated }} דגמים יעודכנו</li>
            <li>{{ r.summary.productsUnchanged }} דגמים בלי שינוי</li>
            <li>
              {{ r.summary.variantsCreated }} וריאנטים חדשים, {{ r.summary.variantsUpdated }} וריאנטים מתעדכנים, מתוכם
              {{ r.summary.priceChanges }} שינויי מחיר
            </li>
          </ul>
          @if (!r.applied) {
            <div class="actions">
              <button matButton="filled" type="button" [disabled]="busy() || nothingToDo(r)" (click)="apply()">
                אישור וייבוא
              </button>
              @if (nothingToDo(r)) {
                <span class="muted">אין מה לעדכן.</span>
              }
            </div>
          } @else {
            <p class="muted">
              כל שינוי נרשם ביומן השינויים. מוצרים חדשים מחכים ב<a
                routerLink="/catalog/products"
                [queryParams]="{ status: 'hidden' }"
                >רשימת המוסתרים</a
              >
              להשלמת תמונות ותיאור.
            </p>
          }
        </section>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-4);
    }

    h1,
    .page-intro {
      margin: 0;
    }

    .panel h2 {
      font-size: var(--font-h3);
      margin: 0;
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
      margin: 0;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-3);
    }

    svg {
      inline-size: var(--icon-size-md);
      block-size: var(--icon-size-md);
    }

    .file-button {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-5);
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
      cursor: pointer;
    }

    .file-button:focus-within {
      outline: var(--focus-ring-width) solid var(--color-focus-ring);
      outline-offset: var(--focus-ring-offset);
    }

    .file-button.disabled {
      opacity: 0.6;
      cursor: default;
    }

    .file-button input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: inherit;
    }

    .file-name {
      font-size: var(--font-small);
      overflow-wrap: anywhere;
    }

    .bad {
      color: var(--color-danger);
    }

    .good {
      color: var(--color-success);
    }

    .table-scroll {
      position: relative;
      overflow-x: auto;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }

    .issues {
      inline-size: 100%;
      border-collapse: collapse;
      font-size: var(--font-small);
    }

    .issues th {
      text-align: start;
      background: var(--color-surface-alt);
      color: var(--color-text-secondary);
      padding: var(--space-2);
      white-space: nowrap;
    }

    .issues td {
      padding: var(--space-2);
      border-block-start: var(--border-width) solid var(--color-border);
    }

    .summary {
      margin: 0;
      padding-inline-start: var(--space-5);
      display: grid;
      gap: var(--space-1);
    }
  `,
})
export class ExcelPage {
  private readonly api = inject(CatalogApi);
  protected readonly file = signal<File | null>(null);
  protected readonly report = signal<ImportReport | null>(null);
  protected readonly busy = signal(false);
  protected readonly step = signal<'check' | 'import'>('check');
  protected readonly error = signal('');

  async download(what: 'template' | 'export') {
    await this.run(() => this.api.downloadExcel(what));
  }

  choose(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    this.file.set(file);
    void this.upload('check');
  }

  apply() {
    void this.upload('import');
  }

  nothingToDo(r: ImportReport): boolean {
    return r.summary.productsCreated + r.summary.productsUpdated === 0;
  }

  issueText(issue: ImportIssue): string {
    if (issue.code === 'rejected' && issue.catalogCode) return catalogIssueText(issue.catalogCode);
    return ISSUES[issue.code];
  }

  private async upload(step: 'check' | 'import') {
    const file = this.file();
    if (!file) return;
    this.step.set(step);
    if (step === 'check') this.report.set(null);
    await this.run(async () => this.report.set(await this.api.uploadExcel(file, step)));
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(
        e instanceof Object && 'status' in e && e.status === 413
          ? 'הקובץ גדול מדי (עד 5MB). חלקו אותו לכמה קבצים.'
          : errorMessage(e),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
