import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import type { AdminAnnouncement } from '@hg/models';
import { errorMessage } from '../core/errors';
import { CONTENT_STATUS_LABELS, contentDatesText, contentStatus } from './content-status';
import { ContentApi } from './content.api';

/**
 * "פס הודעות" (spec §5, NAV-04, permission content.manage): every announcement with its state, dates and order. The
 * site shows one bar at a time: the live one with the lowest order number.
 */
@Component({
  selector: 'hga-announcements-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <div class="head">
      <h1>פס הודעות</h1>
      <a matButton="filled" routerLink="/content/announcements/new">
        <svg lucidePlus></svg>
        הודעה חדשה
      </a>
    </div>
    <p class="page-intro">
      באתר מוצגת הודעה אחת בכל רגע: ההודעה הפעילה עם מספר הסדר הנמוך ביותר. שינוי בטקסט או בקישור מציג אותה שוב גם למי
      שסגר אותה.
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
        @for (a of list; track a.id) {
          <li class="row" [attr.data-state]="status(a)">
            <a class="name" [routerLink]="['/content/announcements', a.id]">{{ a.textHe }}</a>
            <span class="meta"
              ><span class="visually-hidden">תאריכים: </span>{{ datesText(a) }} · סדר <bdi>{{ a.sortOrder }}</bdi></span
            >
            <span class="state"><span class="visually-hidden">מצב: </span>{{ labels[status(a)] }}</span>
            <span class="row-actions">
              <a matButton="outlined" [routerLink]="['/content/announcements', a.id]">עריכה</a>
              <button
                matButton
                type="button"
                [disabled]="busy() === a.id"
                [attr.aria-label]="'מחיקה: ' + a.textHe"
                (click)="remove(a)"
              >
                מחיקה
              </button>
            </span>
          </li>
        } @empty {
          <li class="empty">אין הודעות עדיין. אפשר להוסיף הודעה בכפתור "הודעה חדשה".</li>
        }
      </ul>
    } @else if (!error()) {
      <p class="page-intro" role="status">טוען…</p>
    }
  `,
})
export class AnnouncementsPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminAnnouncement[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly labels = CONTENT_STATUS_LABELS;
  protected readonly datesText = contentDatesText;
  protected readonly status = (a: AdminAnnouncement) => contentStatus(a);

  constructor() {
    void this.load();
  }

  async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.announcements());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(a: AdminAnnouncement) {
    if (!confirm(`למחוק את ההודעה "${a.textHe}"? אי אפשר לשחזר.`)) return;
    this.busy.set(a.id);
    this.error.set('');
    try {
      await this.api.deleteAnnouncement(a.id);
      this.items.update((list) => list?.filter((x) => x.id !== a.id) ?? null);
      this.snack.open('ההודעה נמחקה', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }
}
