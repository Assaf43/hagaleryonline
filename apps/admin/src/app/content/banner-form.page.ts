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
import { CONTENT_LIMITS, type AdminBanner, type AdminContentImage } from '@hg/models';
import { errorMessage } from '../core/errors';
import { MAX_DATE, MIN_DATE } from '../core/israel-time';
import { DateField } from '../shared/date-field';
import { bannerInput, emptyBannerForm, toBannerForm, type BannerField, type BannerForm } from './banner-form';
import { ContentImageField } from './content-image-field';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';

type TextField = Exclude<BannerField, 'image'>;

const SERVER_FIELDS: Record<string, BannerField> = {
  nameHe: 'nameHe',
  headlineHe: 'headlineHe',
  sublineHe: 'sublineHe',
  ctaLabelHe: 'ctaLabelHe',
  linkUrl: 'linkUrl',
  imageId: 'image',
  altHe: 'altHe',
  startsAt: 'startDate',
  endsAt: 'endDate',
};

/**
 * Create or edit one banner (`/content/banners/new`, `/:id`; NAV-05): texts, link, desktop photo (required), phone
 * photo (optional), alt text, Israel-day dates. A photo is stored as soon as it is picked.
 */
@Component({
  selector: 'hga-banner-form-page',
  imports: [DateField, FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, ContentImageField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <a class="back" routerLink="/content/banners">חזרה לבאנרים</a>
    <h1>{{ isNew() ? 'באנר חדש' : 'עריכת באנר' }}</h1>

    @if (loadError()) {
      <p class="form-error" role="alert">{{ loadError() }}</p>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <form class="panel" novalidate (submit)="save($event)">
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>שם פנימי</mat-label>
          <input
            matInput
            id="banner-name"
            autocomplete="off"
            [attr.maxlength]="limits.bannerName"
            [ngModel]="form().nameHe"
            (ngModelChange)="set('nameHe', $event)"
            [ngModelOptions]="{ standalone: true }"
            [errorStateMatcher]="fe.matcher('nameHe')"
          />
          <mat-hint>מופיע רק ברשימה כאן, לא באתר</mat-hint>
          <mat-error>{{ fe.all()['nameHe'] }}</mat-error>
        </mat-form-field>

        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>כותרת</mat-label>
            <input
              matInput
              id="banner-headline"
              autocomplete="off"
              [attr.maxlength]="limits.bannerHeadline"
              [ngModel]="form().headlineHe"
              (ngModelChange)="set('headlineHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('headlineHe')"
            />
            <mat-error>{{ fe.all()['headlineHe'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>שורת משנה (לא חובה)</mat-label>
            <input
              matInput
              id="banner-subline"
              autocomplete="off"
              [attr.maxlength]="limits.bannerSubline"
              [ngModel]="form().sublineHe"
              (ngModelChange)="set('sublineHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('sublineHe')"
            />
            <mat-error>{{ fe.all()['sublineHe'] }}</mat-error>
          </mat-form-field>
        </div>

        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>קישור</mat-label>
            <input
              matInput
              id="banner-link"
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
            <mat-label>טקסט הכפתור (לא חובה)</mat-label>
            <input
              matInput
              id="banner-cta"
              autocomplete="off"
              [attr.maxlength]="limits.bannerCta"
              [ngModel]="form().ctaLabelHe"
              (ngModelChange)="set('ctaLabelHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('ctaLabelHe')"
            />
            <mat-error>{{ fe.all()['ctaLabelHe'] }}</mat-error>
          </mat-form-field>
        </div>

        <hga-content-image-field
          label="תמונה לדסקטופ"
          [required]="true"
          [invalid]="!!fe.all()['image']"
          [errorText]="fe.all()['image'] ?? ''"
          [value]="form().image"
          (valueChange)="setImage('image', $event)"
        />
        <hga-content-image-field
          label="תמונה לנייד"
          hint="בלי תמונה לנייד תוצג תמונת הדסקטופ בכל המסכים. מומלצת תמונה מרובעת או לגובה."
          [value]="form().mobileImage"
          (valueChange)="setImage('mobileImage', $event)"
        />

        <mat-form-field subscriptSizing="dynamic">
          <mat-label>טקסט חלופי לתמונה</mat-label>
          <input
            matInput
            id="banner-alt"
            autocomplete="off"
            [attr.maxlength]="limits.bannerAlt"
            [ngModel]="form().altHe"
            (ngModelChange)="set('altHe', $event)"
            [ngModelOptions]="{ standalone: true }"
            [errorStateMatcher]="fe.matcher('altHe')"
          />
          <mat-hint>מתאר את התמונה לקוראי מסך</mat-hint>
          <mat-error>{{ fe.all()['altHe'] }}</mat-error>
        </mat-form-field>

        <fieldset>
          <legend>תאריכים</legend>
          <p class="muted">שעון ישראל. מתחילת יום ההתחלה ועד סוף יום הסיום. ריק = בלי הגבלת תאריך.</p>
          <div class="date-grid">
            <hga-date-field
              label="תאריך התחלה"
              inputId="banner-start"
              subscriptSizing="dynamic"
              [min]="minDate"
              [max]="maxDate"
              [ngModel]="form().startDate"
              (ngModelChange)="set('startDate', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('startDate')"
              [errorText]="fe.all()['startDate'] ?? ''"
            />
            <hga-date-field
              label="תאריך סיום"
              inputId="banner-end"
              subscriptSizing="dynamic"
              [min]="minDate"
              [max]="maxDate"
              [ngModel]="form().endDate"
              (ngModelChange)="set('endDate', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('endDate')"
              [errorText]="fe.all()['endDate'] ?? ''"
            />
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
          <a matButton routerLink="/content/banners">ביטול</a>
        </div>
      </form>
    }
  `,
})
export class BannerFormPage {
  /** "new" or the banner's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly limits = CONTENT_LIMITS;
  protected readonly minDate = MIN_DATE;
  protected readonly maxDate = MAX_DATE;
  protected readonly form = signal<BannerForm>(emptyBannerForm());
  protected readonly saved = signal<AdminBanner | null>(null);
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

  protected setImage(field: 'image' | 'mobileImage', value: AdminContentImage | null) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.fe.clear('image');
  }

  protected setActive(active: boolean) {
    this.form.update((f) => ({ ...f, active }));
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    const { input, errors } = bannerInput(this.form());
    this.fe.set(errors);
    this.problem.set('');
    if (!input) return;
    this.saving.set(true);
    try {
      const prev = this.saved();
      const saved = prev
        ? await this.api.updateBanner(prev.id, { ...input, expectedUpdatedAt: prev.updatedAt })
        : await this.api.createBanner(input);
      this.saved.set(saved);
      this.form.set(toBannerForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('הבאנר נשמר', undefined, { duration: 2500 });
      await this.router.navigateByUrl('/content/banners');
    } catch (e) {
      const r = refusal(e);
      const field = r.field ? SERVER_FIELDS[r.field] : undefined;
      if (field) this.fe.set({ [field]: r.message });
      else this.problem.set(r.message);
    } finally {
      this.saving.set(false);
    }
  }

  private loadSeq = 0;

  private async load(id: string) {
    const seq = ++this.loadSeq;
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const b = id === 'new' ? null : await this.api.banner(Number(id));
      if (seq !== this.loadSeq) return;
      this.saved.set(b);
      this.form.set(b ? toBannerForm(b) : emptyBannerForm());
      this.fe.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
    } catch (e) {
      if (seq === this.loadSeq) this.loadError.set(errorMessage(e));
    }
  }
}
