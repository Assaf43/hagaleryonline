import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import type { AdminFaqGroup } from '@hg/models';
import { errorMessage } from '../core/errors';
import { contentStatus } from './content-status';
import { ContentApi } from './content.api';

/** "שאלות ותשובות" (NAV-04, SRV-04, permission content.manage): the FAQ groups; each opens as a whole to edit. */
@Component({
  selector: 'hga-faq-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <div class="head">
      <h1>שאלות ותשובות</h1>
      <a matButton="filled" routerLink="/content/faq/new">
        <svg lucidePlus></svg>
        קבוצה חדשה
      </a>
    </div>
    <p class="page-intro">
      השאלות מחולקות לקבוצות (למשל משלוחים או תשלום). באתר מופיעות רק קבוצות מפורסמות עם לפחות שאלה אחת מפורסמת.
    </p>

    @if (error()) {
      <div class="form-error" role="alert">
        <p>{{ error() }}</p>
        @if (!items()) {
          <button matButton="outlined" type="button" (click)="load()">נסו שוב</button>
        }
      </div>
    }

    @if (items(); as list) {
      <ul class="rows">
        @for (g of list; track g.id) {
          <li class="row" [attr.data-state]="status(g)">
            <a class="name" [routerLink]="['/content/faq', g.id]">{{ g.titleHe }}</a>
            <span class="meta"
              >שאלות: <bdi>{{ g.items.length }}</bdi> · סדר <bdi>{{ g.sortOrder }}</bdi></span
            >
            <span class="state"
              ><span class="visually-hidden">מצב: </span>{{ g.published ? 'מפורסם' : 'לא מפורסם' }}</span
            >
            <span class="row-actions">
              <a matButton="outlined" [routerLink]="['/content/faq', g.id]">עריכה</a>
              <button
                matButton
                type="button"
                [disabled]="busy() === g.id"
                [attr.aria-label]="'מחיקה: ' + g.titleHe"
                (click)="remove(g)"
              >
                מחיקה
              </button>
            </span>
          </li>
        } @empty {
          <li class="empty">אין קבוצות עדיין. אפשר להוסיף קבוצה בכפתור "קבוצה חדשה".</li>
        }
      </ul>
    } @else if (!error()) {
      <p class="page-intro" role="status">טוען…</p>
    }
  `,
})
export class FaqPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminFaqGroup[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly status = (g: AdminFaqGroup) => contentStatus({ active: g.published });

  constructor() {
    void this.load();
  }

  async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.faqGroups());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(g: AdminFaqGroup) {
    if (!confirm(`למחוק את הקבוצה "${g.titleHe}" ואת כל השאלות שבה? אי אפשר לשחזר.`)) return;
    this.busy.set(g.id);
    this.error.set('');
    try {
      await this.api.deleteFaqGroup(g.id);
      this.items.update((list) => list?.filter((x) => x.id !== g.id) ?? null);
      this.snack.open('הקבוצה נמחקה', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }
}
