import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import type { AdminInfoPage } from '@hg/models';
import { errorMessage } from '../core/errors';
import { contentStatus } from './content-status';
import { ContentApi } from './content.api';

/**
 * "עמודי מידע" (spec §5, SRV-04, permission content.manage): terms, privacy, shipping, returns, warranty (system
 * pages: always published, no delete) and any page the editors add. The "טקסט זמני" badge marks seeded text that no
 * editor has saved yet.
 */
@Component({
  selector: 'hga-info-pages-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <div class="head">
      <h1>עמודי מידע</h1>
      <a matButton="filled" routerLink="/content/pages/new">
        <svg lucidePlus></svg>
        עמוד חדש
      </a>
    </div>
    <p class="page-intro">
      עמודי המערכת (תקנון, פרטיות, משלוחים, החזרות ואחריות) תמיד מפורסמים ואי אפשר למחוק אותם. עמוד שמסומן "טקסט זמני"
      עדיין מכיל את הנוסח ההתחלתי, ויש לעבור עליו לפני ההשקה.
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
        @for (p of list; track p.id) {
          <li class="row" [attr.data-state]="status(p)">
            <a class="name" [routerLink]="['/content/pages', p.id]">{{ p.titleHe }}</a>
            <span class="meta">
              <bdi dir="ltr">/{{ p.slug }}</bdi>
              @if (p.systemKey) {
                · עמוד מערכת
              }
              @if (p.showInFooter) {
                · בכותרת התחתונה
              }
              @if (p.noindex) {
                · ללא אינדוקס
              }
            </span>
            <span class="badges">
              <span class="state"
                ><span class="visually-hidden">מצב: </span>{{ p.published ? 'מפורסם' : 'לא מפורסם' }}</span
              >
              @if (p.interim) {
                <span class="badge interim">טקסט זמני</span>
              }
            </span>
            <span class="row-actions">
              <a matButton="outlined" [routerLink]="['/content/pages', p.id]">עריכה</a>
              @if (!p.systemKey) {
                <button
                  matButton
                  type="button"
                  [disabled]="busy() === p.id"
                  [attr.aria-label]="'מחיקה: ' + p.titleHe"
                  (click)="remove(p)"
                >
                  מחיקה
                </button>
              }
            </span>
          </li>
        } @empty {
          <li class="empty">אין עמודים עדיין.</li>
        }
      </ul>
    } @else if (!error()) {
      <p class="page-intro" role="status">טוען…</p>
    }
  `,
})
export class InfoPagesPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminInfoPage[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly status = (p: AdminInfoPage) => contentStatus({ active: p.published });

  constructor() {
    void this.load();
  }

  async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.pages());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(p: AdminInfoPage) {
    if (!confirm(`למחוק את העמוד "${p.titleHe}"? אי אפשר לשחזר.`)) return;
    this.busy.set(p.id);
    this.error.set('');
    try {
      await this.api.deletePage(p.id);
      this.items.update((list) => list?.filter((x) => x.id !== p.id) ?? null);
      this.snack.open('העמוד נמחק', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }
}
