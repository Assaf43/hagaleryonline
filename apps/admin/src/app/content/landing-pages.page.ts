import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import type { AdminLandingPage } from '@hg/models';
import { errorMessage } from '../core/errors';
import { LANDING_STATE_LABELS, landingDatesText } from './landing-form';
import { ContentApi } from './content.api';

/**
 * "עמודי נחיתה" (spec §5, MKT-02, decision 97, permission content.manage): every landing page with its address, state
 * (טיוטה / מתוזמן / פעיל / הסתיים) and dates. A page lives at `/collection/<address>` on the site.
 */
@Component({
  selector: 'hga-landing-pages-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <div class="head">
      <h1>עמודי נחיתה</h1>
      <a matButton="filled" routerLink="/content/landing/new">
        <svg lucidePlus></svg>
        עמוד נחיתה חדש
      </a>
    </div>
    <p class="page-intro">
      עמוד נחיתה הוא עמוד קמפיין בכתובת נפרדת באתר, עם תמונת פתיחה, טקסט ורשת מוצרים. הוא מוצג רק כשהוא מפורסם ובטווח
      התאריכים שלו. אחרי תאריך הסיום מוצגת הודעה עם קישור להמשך.
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
          <li class="row" [attr.data-state]="rowState(p)">
            <a class="name" [routerLink]="['/content/landing', p.id]">{{ p.titleHe }}</a>
            <span class="meta">
              <bdi dir="ltr">/collection/{{ p.slug }}</bdi>
              ·
              <span class="visually-hidden">תאריכים: </span>{{ datesText(p) }}
            </span>
            <span class="badges">
              <span class="state"><span class="visually-hidden">מצב: </span>{{ labels[p.state] }}</span>
            </span>
            <span class="row-actions">
              <a matButton="outlined" [routerLink]="['/content/landing', p.id]">עריכה</a>
              <button
                matButton
                type="button"
                [disabled]="busy() === p.id"
                [attr.aria-label]="'מחיקה: ' + p.titleHe"
                (click)="remove(p)"
              >
                מחיקה
              </button>
            </span>
          </li>
        } @empty {
          <li class="empty">אין עמודי נחיתה עדיין. אפשר להוסיף בכפתור "עמוד נחיתה חדש".</li>
        }
      </ul>
    } @else if (!error()) {
      <p class="page-intro" role="status">טוען…</p>
    }
  `,
})
export class LandingPagesPage {
  private readonly api = inject(ContentApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminLandingPage[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly labels = LANDING_STATE_LABELS;
  protected readonly datesText = landingDatesText;
  /** The shared row styles know "active" and "scheduled". */
  protected readonly rowState = (p: AdminLandingPage) => (p.state === 'live' ? 'active' : p.state);

  constructor() {
    void this.load();
  }

  async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.landingPages());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async remove(p: AdminLandingPage) {
    if (!confirm(`למחוק את עמוד הנחיתה "${p.titleHe}"? הקישור יפסיק לעבוד ואי אפשר לשחזר.`)) return;
    this.busy.set(p.id);
    this.error.set('');
    try {
      await this.api.deleteLandingPage(p.id);
      this.items.update((list) => list?.filter((x) => x.id !== p.id) ?? null);
      this.snack.open('עמוד הנחיתה נמחק', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }
}
