import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CONTENT_LIMITS, type AdminAnnouncement } from '@hg/models';
import { errorMessage } from '../core/errors';
import { MAX_DATE, MIN_DATE } from '../core/israel-time';
import {
  announcementInput,
  emptyAnnouncementForm,
  toAnnouncementForm,
  type AnnouncementForm,
} from './announcement-form';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';

type TextField = 'textHe' | 'linkUrl' | 'linkLabelHe' | 'sortOrder' | 'startDate' | 'endDate';

const SERVER_FIELDS: Record<string, string> = {
  textHe: 'textHe',
  linkUrl: 'linkUrl',
  linkLabelHe: 'linkLabelHe',
  sortOrder: 'sortOrder',
  startsAt: 'startDate',
  endsAt: 'endDate',
};

/** Create or edit one announcement (`/content/announcements/new`, `/:id`; NAV-04): text, link, order, Israel-day dates. */
@Component({
  selector: 'hga-announcement-form-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <a class="back" routerLink="/content/announcements">חזרה לפס הודעות</a>
    <h1>{{ isNew() ? 'הודעה חדשה' : 'עריכת הודעה' }}</h1>

    @if (loadError()) {
      <p class="form-error" role="alert">{{ loadError() }}</p>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <form class="panel" novalidate (submit)="save($event)">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>טקסט ההודעה</mat-label>
          <input
            matInput
            id="ann-text"
            autocomplete="off"
            [attr.maxlength]="limits.announcementText"
            [ngModel]="form().textHe"
            (ngModelChange)="set('textHe', $event)"
            [ngModelOptions]="{ standalone: true }"
            [errorStateMatcher]="fe.matcher('textHe')"
          />
          <mat-hint>עד {{ limits.announcementText }} תווים</mat-hint>
          <mat-error>{{ fe.all()['textHe'] }}</mat-error>
        </mat-form-field>

        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>קישור (לא חובה)</mat-label>
            <input
              matInput
              id="ann-link"
              dir="ltr"
              autocomplete="off"
              [ngModel]="form().linkUrl"
              (ngModelChange)="set('linkUrl', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('linkUrl')"
            />
            <mat-hint>https://, mailto:, tel: או כתובת באתר שמתחילה ב-/</mat-hint>
            <mat-error>{{ fe.all()['linkUrl'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>טקסט הקישור</mat-label>
            <input
              matInput
              id="ann-link-label"
              autocomplete="off"
              [attr.maxlength]="limits.linkLabel"
              [ngModel]="form().linkLabelHe"
              (ngModelChange)="set('linkLabelHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('linkLabelHe')"
            />
            <mat-error>{{ fe.all()['linkLabelHe'] }}</mat-error>
          </mat-form-field>
        </div>

        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>סדר</mat-label>
            <input
              matInput
              id="ann-order"
              inputmode="numeric"
              autocomplete="off"
              [ngModel]="form().sortOrder"
              (ngModelChange)="set('sortOrder', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('sortOrder')"
            />
            <mat-hint>מספר נמוך מוצג קודם</mat-hint>
            <mat-error>{{ fe.all()['sortOrder'] }}</mat-error>
          </mat-form-field>
        </div>

        <fieldset>
          <legend>תאריכים</legend>
          <p class="muted">שעון ישראל. מתחילת יום ההתחלה ועד סוף יום הסיום. ריק = בלי הגבלת תאריך.</p>
          <div class="date-grid">
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>תאריך התחלה</mat-label>
              <input
                matInput
                type="date"
                id="ann-start"
                [min]="minDate"
                [max]="maxDate"
                [ngModel]="form().startDate"
                (ngModelChange)="set('startDate', $event)"
                [ngModelOptions]="{ standalone: true }"
                [errorStateMatcher]="fe.matcher('startDate')"
              />
              <mat-error>{{ fe.all()['startDate'] }}</mat-error>
            </mat-form-field>
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>תאריך סיום</mat-label>
              <input
                matInput
                type="date"
                id="ann-end"
                [min]="minDate"
                [max]="maxDate"
                [ngModel]="form().endDate"
                (ngModelChange)="set('endDate', $event)"
                [ngModelOptions]="{ standalone: true }"
                [errorStateMatcher]="fe.matcher('endDate')"
              />
              <mat-error>{{ fe.all()['endDate'] }}</mat-error>
            </mat-form-field>
          </div>
        </fieldset>

        <label class="option">
          <input type="checkbox" [checked]="form().active" (change)="setActive($any($event.target).checked)" />
          <span>פעיל</span>
        </label>

        @if (problem()) {
          <p class="form-error" role="alert">{{ problem() }}</p>
        }
        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">שמירה</button>
          <a matButton routerLink="/content/announcements">ביטול</a>
        </div>
      </form>
    }
  `,
})
export class AnnouncementFormPage {
  /** "new" or the announcement's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly limits = CONTENT_LIMITS;
  protected readonly minDate = MIN_DATE;
  protected readonly maxDate = MAX_DATE;
  protected readonly form = signal<AnnouncementForm>(emptyAnnouncementForm());
  protected readonly saved = signal<AdminAnnouncement | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly isNew = computed(() => this.id() === 'new');
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.form()) !== this.baseline());

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  canLeave(): boolean {
    return !this.dirty() || confirm(LEAVE_PROMPT);
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  protected set(field: TextField, value: string) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.fe.clear(field);
    if (field === 'startDate') this.fe.clear('endDate');
  }

  protected setActive(active: boolean) {
    this.form.update((f) => ({ ...f, active }));
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    const { input, errors } = announcementInput(this.form());
    this.fe.set(errors);
    this.problem.set('');
    if (!input) return;
    this.saving.set(true);
    try {
      const prev = this.saved();
      const saved = prev
        ? await this.api.updateAnnouncement(prev.id, { ...input, expectedUpdatedAt: prev.updatedAt })
        : await this.api.createAnnouncement(input);
      this.saved.set(saved);
      this.form.set(toAnnouncementForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('ההודעה נשמרה', undefined, { duration: 2500 });
      await this.router.navigateByUrl('/content/announcements');
    } catch (e) {
      const r = refusal(e);
      const field = r.field ? SERVER_FIELDS[r.field] : undefined;
      if (field) this.fe.set({ [field]: r.message });
      else this.problem.set(r.message);
    } finally {
      this.saving.set(false);
    }
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const a = id === 'new' ? null : await this.api.announcement(Number(id));
      this.saved.set(a);
      this.form.set(a ? toAnnouncementForm(a) : emptyAnnouncementForm());
      this.fe.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}
