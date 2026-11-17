import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import type { AdminBanner } from '@hg/models';
import { errorMessage } from '../core/errors';
import { CONTENT_STATUS_LABELS, contentDatesText, contentStatus } from './content-status';
import { ContentApi } from './content.api';

/**
 * "באנרים" (spec §5, NAV-05, permission content.manage): every banner with its photo, state and dates. A banner that a
 * home page section uses cannot be deleted; the API names the sections.
 */
@Component({
  selector: 'hga-banners-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./content.scss', './banners.scss'],
  template: `
    <div class="head">
      <h1>באנרים</h1>
      <a matButton="filled" routerLink="/content/banners/new">
        <svg lucidePlus></svg>
        באנר חדש
      </a>
    </div>
    <p class="page-intro">
      הבאנרים מוצגים בדף הבית, באזורים "באנר ראשי" ו"זוג באנרים" שמוגדרים במסך "דף הבית". באנר מוצג רק כשהוא פעיל ובטווח
      התאריכים שלו.
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
        @for (b of list; track b.id) {
          <li class="row banner-row" [attr.data-state]="status(b)">
            <img class="thumb" [src]="b.image.url" alt="" loading="lazy" />
            <a class="name" [routerLink]="['/content/banners', b.id]">{{ b.nameHe }}</a>
            <span class="meta"
              ><span class="visually-hidden">כותרת: </span>{{ b.headlineHe }} ·
              <span class="visually-hidden">תאריכים: </span>{{ datesText(b) }}</span
            >
            <span class="state"><span class="visually-hidden">מצב: </span>{{ labels[status(b)] }}</span>
            <span class="row-actions">
              <a matButton="outlined" [routerLink]="['/content/banners', b.id]">עריכה</a>
              <button
                matButton
                type="button"
                [disabled]="busy() === b.id"
                [attr.aria-label]="'מחיקה: ' + b.nameHe"
                (click)="remove(b)"
              >
                מחיקה
              </button>
            </span>
          </li>
        } @empty {
          <li class="empty">אין באנרים עדיין. אפשר להוסיף באנר בכפתור "באנר חדש".</li>
        }
      </ul>
    } @else if (!error()) {
      <p class="page-intro" role="status">טוען…</p>
    }
  `,
})
export class BannersPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminBanner[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly labels = CONTENT_STATUS_LABELS;
  protected readonly datesText = contentDatesText;
  protected readonly status = (b: AdminBanner) => contentStatus(b);

  constructor() {
    void this.load();
  }

  async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.banners());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(b: AdminBanner) {
    if (!confirm(`למחוק את הבאנר "${b.nameHe}"? אי אפשר לשחזר.`)) return;
    this.busy.set(b.id);
    this.error.set('');
    try {
      await this.api.deleteBanner(b.id);
      this.items.update((list) => list?.filter((x) => x.id !== b.id) ?? null);
      this.snack.open('הבאנר נמחק', undefined, { duration: 2500 });
    } catch (e) {
      // 409 banner_in_use names the home sections that still show it.
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }
}
