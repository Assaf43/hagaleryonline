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
import { CONTENT_LIMITS, CONTENT_SLUG_PATTERN, type AdminInfoPage, type AdminInfoPageInput } from '@hg/models';
import { errorMessage } from '../core/errors';
import { RichTextEditor } from '../shared/rich-text-editor';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';

interface PageForm {
  slug: string;
  titleHe: string;
  bodyHtml: string;
  metaDescriptionHe: string;
  published: boolean;
  noindex: boolean;
  showInFooter: boolean;
  footerLabelHe: string;
  footerOrder: string;
}

type TextField = 'slug' | 'titleHe' | 'metaDescriptionHe' | 'footerLabelHe' | 'footerOrder';

const empty = (): PageForm => ({
  slug: '',
  titleHe: '',
  bodyHtml: '',
  metaDescriptionHe: '',
  published: false,
  noindex: false,
  showInFooter: false,
  footerLabelHe: '',
  footerOrder: '0',
});

const toForm = (p: AdminInfoPage): PageForm => ({
  slug: p.slug,
  titleHe: p.titleHe,
  bodyHtml: p.bodyHtml,
  metaDescriptionHe: p.metaDescriptionHe ?? '',
  published: p.published,
  noindex: p.noindex,
  showInFooter: p.showInFooter,
  footerLabelHe: p.footerLabelHe ?? '',
  footerOrder: String(p.footerOrder),
});

/** Create or edit one info page (`/content/pages/new`, `/:id`; SRV-04). A system page keeps its slug and stays published. */
@Component({
  selector: 'hga-info-page-form-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, RichTextEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <a class="back" routerLink="/content/pages">חזרה לעמודי מידע</a>
    <h1>{{ isNew() ? 'עמוד חדש' : 'עריכת עמוד' }}</h1>

    @if (loadError()) {
      <p class="form-error" role="alert">{{ loadError() }}</p>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <form class="panel" novalidate (submit)="save($event)">
        @if (saved()?.interim) {
          <p class="notice">טקסט זמני: זה הנוסח ההתחלתי של העמוד. שמירה מסירה את הסימון.</p>
        }

        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>כותרת העמוד</mat-label>
            <input
              matInput
              id="page-title"
              autocomplete="off"
              [attr.maxlength]="limits.title"
              [ngModel]="form().titleHe"
              (ngModelChange)="set('titleHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('titleHe')"
            />
            <mat-error>{{ fe.all()['titleHe'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>כתובת באתר</mat-label>
            <input
              matInput
              id="page-slug"
              dir="ltr"
              autocomplete="off"
              [attr.maxlength]="limits.slug"
              [readonly]="system()"
              [ngModel]="form().slug"
              (ngModelChange)="set('slug', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('slug')"
            />
            <mat-hint>
              @if (system()) {
                עמוד מערכת: אי אפשר לשנות את הכתובת
              } @else {
                אותיות באנגלית קטנות, ספרות ומקפים. למשל: about-us
              }
            </mat-hint>
            <mat-error>{{ fe.all()['slug'] }}</mat-error>
          </mat-form-field>
        </div>

        <hga-rich-text-editor
          mode="page"
          label="תוכן העמוד"
          [value]="form().bodyHtml"
          (valueChange)="setBody($event)"
        />
        @if (fe.all()['bodyHtml']; as bodyError) {
          <p class="field-error" role="alert">{{ bodyError }}</p>
        }

        <mat-form-field subscriptSizing="dynamic">
          <mat-label>תיאור לגוגל (לא חובה)</mat-label>
          <textarea
            matInput
            id="page-meta"
            rows="2"
            [attr.maxlength]="limits.metaDescription"
            [ngModel]="form().metaDescriptionHe"
            (ngModelChange)="set('metaDescriptionHe', $event)"
            [ngModelOptions]="{ standalone: true }"
            [errorStateMatcher]="fe.matcher('metaDescriptionHe')"
          ></textarea>
          <mat-hint>עד {{ limits.metaDescription }} תווים</mat-hint>
          <mat-error>{{ fe.all()['metaDescriptionHe'] }}</mat-error>
        </mat-form-field>

        <div class="switch-row">
          <label class="option">
            <input
              type="checkbox"
              id="page-published"
              aria-describedby="page-published-hint"
              [checked]="form().published"
              [disabled]="system()"
              (change)="setFlag('published', $any($event.target).checked)"
            />
            <span>מפורסם</span>
          </label>
          @if (system()) {
            <p class="muted" id="page-published-hint">עמוד מערכת: תמיד מפורסם</p>
          }
        </div>
        <label class="option">
          <input
            type="checkbox"
            [checked]="form().noindex"
            (change)="setFlag('noindex', $any($event.target).checked)"
          />
          <span>ללא אינדוקס בגוגל</span>
        </label>

        <fieldset>
          <legend>בכותרת התחתונה</legend>
          <label class="option">
            <input
              type="checkbox"
              [checked]="form().showInFooter"
              (change)="setFlag('showInFooter', $any($event.target).checked)"
            />
            <span>הצגה בכותרת התחתונה של האתר</span>
          </label>
          @if (form().showInFooter) {
            <div class="fields">
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>שם בכותרת התחתונה (לא חובה)</mat-label>
                <input
                  matInput
                  id="page-footer-label"
                  autocomplete="off"
                  [attr.maxlength]="limits.linkLabel"
                  [ngModel]="form().footerLabelHe"
                  (ngModelChange)="set('footerLabelHe', $event)"
                  [ngModelOptions]="{ standalone: true }"
                  [errorStateMatcher]="fe.matcher('footerLabelHe')"
                />
                <mat-hint>ריק = כותרת העמוד</mat-hint>
                <mat-error>{{ fe.all()['footerLabelHe'] }}</mat-error>
              </mat-form-field>
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>סדר בכותרת התחתונה</mat-label>
                <input
                  matInput
                  id="page-footer-order"
                  inputmode="numeric"
                  autocomplete="off"
                  [ngModel]="form().footerOrder"
                  (ngModelChange)="set('footerOrder', $event)"
                  [ngModelOptions]="{ standalone: true }"
                  [errorStateMatcher]="fe.matcher('footerOrder')"
                />
                <mat-hint>מספר נמוך מוצג קודם</mat-hint>
                <mat-error>{{ fe.all()['footerOrder'] }}</mat-error>
              </mat-form-field>
            </div>
          }
        </fieldset>

        @if (problem()) {
          <p class="form-error" role="alert">{{ problem() }}</p>
        }
        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">שמירה</button>
          <a matButton routerLink="/content/pages">ביטול</a>
        </div>
      </form>
    }
  `,
})
export class InfoPageFormPage {
  /** "new" or the page's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly limits = CONTENT_LIMITS;
  protected readonly form = signal<PageForm>(empty());
  protected readonly saved = signal<AdminInfoPage | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly isNew = computed(() => this.id() === 'new');
  /** A system page: fixed slug, always published, never deleted. */
  protected readonly system = computed(() => !!this.saved()?.systemKey);
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
  }

  protected setBody(bodyHtml: string) {
    this.form.update((f) => ({ ...f, bodyHtml }));
    this.fe.clear('bodyHtml');
  }

  protected setFlag(flag: 'published' | 'noindex' | 'showInFooter', value: boolean) {
    this.form.update((f) => ({ ...f, [flag]: value }));
  }

  private input(): AdminInfoPageInput | null {
    const f = this.form();
    const errors: Record<string, string> = {};
    const slug = f.slug.trim();
    if (!slug || slug.length > CONTENT_LIMITS.slug || !CONTENT_SLUG_PATTERN.test(slug)) {
      errors['slug'] = 'הכתובת צריכה להכיל אותיות באנגלית קטנות, ספרות ומקפים בלבד (למשל: about-us).';
    }
    const title = f.titleHe.trim();
    if (!title || title.length > CONTENT_LIMITS.title) {
      errors['titleHe'] = `יש למלא כותרת (עד ${CONTENT_LIMITS.title} תווים).`;
    }
    if (!f.bodyHtml.trim()) errors['bodyHtml'] = 'יש למלא את תוכן העמוד.';
    if (!/^\d{1,6}$/.test(f.footerOrder.trim())) errors['footerOrder'] = 'הסדר חייב להיות מספר שלם, 0 ומעלה.';
    this.fe.set(errors);
    if (Object.keys(errors).length) return null;
    return {
      slug,
      titleHe: title,
      bodyHtml: f.bodyHtml,
      metaDescriptionHe: f.metaDescriptionHe.trim() || null,
      published: this.system() ? true : f.published,
      noindex: f.noindex,
      showInFooter: f.showInFooter,
      footerLabelHe: f.showInFooter ? f.footerLabelHe.trim() || null : null,
      footerOrder: Number(f.footerOrder.trim()),
    };
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    this.problem.set('');
    const input = this.input();
    if (!input) return;
    this.saving.set(true);
    try {
      const prev = this.saved();
      const saved = prev
        ? await this.api.updatePage(prev.id, { ...input, expectedUpdatedAt: prev.updatedAt })
        : await this.api.createPage(input);
      this.saved.set(saved);
      this.form.set(toForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('העמוד נשמר', undefined, { duration: 2500 });
      await this.router.navigateByUrl('/content/pages');
    } catch (e) {
      const r = refusal(e);
      const known = ['slug', 'titleHe', 'bodyHtml', 'metaDescriptionHe', 'footerLabelHe', 'footerOrder'];
      if (r.field && known.includes(r.field)) this.fe.set({ [r.field]: r.message });
      else if (r.code === 'slug_taken') this.fe.set({ slug: r.message });
      else this.problem.set(r.message);
    } finally {
      this.saving.set(false);
    }
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const p = id === 'new' ? null : await this.api.page(Number(id));
      this.saved.set(p);
      this.form.set(p ? toForm(p) : empty());
      this.fe.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}
