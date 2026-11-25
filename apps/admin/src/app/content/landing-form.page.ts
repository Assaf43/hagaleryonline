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
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  CONTENT_LIMITS,
  type AdminCategory,
  type AdminContentImage,
  type AdminLandingPage,
  type AdminPromotionSource,
  type AdminRoom,
  type LandingStatus,
  type ProductSource,
  type RelatedPick,
} from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { MAX_DATE, MIN_DATE } from '../core/israel-time';
import { DateField } from '../shared/date-field';
import { RichTextEditor } from '../shared/rich-text-editor';
import { ContentImageField } from './content-image-field';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';
import { categoryOptions, promotionOptions } from './home-section.dialog';
import type { IdOption } from './id-list-field';
import {
  LANDING_STATE_LABELS,
  LANDING_STATUS_LABELS,
  emptyLandingForm,
  landingInput,
  toLandingForm,
  type LandingField,
  type LandingForm,
} from './landing-form';
import { ProductSourceField, loadSourcePicks } from './product-source-field';

type TextField =
  'slug' | 'titleHe' | 'sublineHe' | 'altHe' | 'startDate' | 'endDate' | 'endedLinkUrl' | 'metaDescriptionHe';

const SERVER_FIELDS: Record<string, LandingField> = {
  slug: 'slug',
  titleHe: 'titleHe',
  sublineHe: 'sublineHe',
  introHtml: 'introHtml',
  outroHtml: 'outroHtml',
  imageId: 'image',
  mobileImageId: 'image',
  altHe: 'altHe',
  source: 'source',
  'source.id': 'source',
  'source.productIds': 'source',
  startsAt: 'startDate',
  endsAt: 'endDate',
  endedLinkUrl: 'endedLinkUrl',
  metaDescriptionHe: 'metaDescriptionHe',
};

const LANDING_UNAVAILABLE_NOTE =
  'המקור הזה לא מוצג באתר כרגע (הקטגוריה, החדר או המבצע הוסתרו, הסתיימו או נמחקו). העמוד יציג "אין כרגע מוצרים להצגה".';

/**
 * Create or edit one landing page (`/content/landing/new`, `/:id`; MKT-02, decision 97): details, opening photo, the
 * product source, closing text and publishing. "תצוגה מקדימה" (on a saved page) asks the API for a signed storefront
 * address and opens it in a new tab; if the browser blocks the tab a link button is shown instead.
 */
@Component({
  selector: 'hga-landing-form-page',
  imports: [
    DateField,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ContentImageField,
    ProductSourceField,
    RichTextEditor,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./content.scss', './landing.scss'],
  template: `
    <a class="back" routerLink="/content/landing">חזרה לעמודי נחיתה</a>
    <div class="head">
      <h1>{{ isNew() ? 'עמוד נחיתה חדש' : 'עריכת עמוד נחיתה' }}</h1>
      @if (saved()) {
        <button matButton="outlined" type="button" class="preview" [disabled]="previewing()" (click)="preview()">
          תצוגה מקדימה
        </button>
      }
    </div>

    @if (loadError()) {
      <p class="form-error" role="alert">{{ loadError() }}</p>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      @if (saved(); as page) {
        <p class="muted state-line">
          מצב כעת: <strong>{{ stateLabels[page.state] }}</strong>
          @if (page.state === 'scheduled') {
            · יעלה לאתר בתאריך ההתחלה
          } @else if (page.state === 'ended') {
            · באתר מוצגת הודעה שהמבצע הסתיים
          }
        </p>
      }
      @if (previewUrl(); as url) {
        <p class="notice" role="status">
          הדפדפן חסם את פתיחת הלשונית.
          <a matButton="tonal" class="open-preview" [href]="url" target="_blank" rel="noopener">
            פתיחת התצוגה המקדימה
          </a>
        </p>
      }
      @if (previewError()) {
        <p class="form-error" role="alert">{{ previewError() }}</p>
      }
      @if (saved() && dirty()) {
        <p class="muted" role="status">התצוגה המקדימה מציגה את הגרסה השמורה. שמרו קודם כדי לראות שינויים.</p>
      }

      <form class="panel" novalidate (submit)="save($event)">
        <fieldset>
          <legend>פרטים</legend>
          <div class="fields">
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>כותרת</mat-label>
              <input
                matInput
                id="landing-title"
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
              <mat-label>כתובת באנגלית</mat-label>
              <input
                matInput
                id="landing-slug"
                dir="ltr"
                autocomplete="off"
                [attr.maxlength]="limits.slug"
                [ngModel]="form().slug"
                (ngModelChange)="set('slug', $event)"
                [ngModelOptions]="{ standalone: true }"
                [errorStateMatcher]="fe.matcher('slug')"
              />
              <mat-hint>העמוד יופיע בכתובת /collection/{{ form().slug.trim() || 'winter-sale' }}</mat-hint>
              <mat-error>{{ fe.all()['slug'] }}</mat-error>
            </mat-form-field>
          </div>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>משפט משנה (לא חובה)</mat-label>
            <input
              matInput
              id="landing-subline"
              autocomplete="off"
              [attr.maxlength]="limits.landingSubline"
              [ngModel]="form().sublineHe"
              (ngModelChange)="set('sublineHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('sublineHe')"
            />
            <mat-error>{{ fe.all()['sublineHe'] }}</mat-error>
          </mat-form-field>
          <hga-rich-text-editor
            mode="page"
            label="טקסט פתיחה"
            [value]="form().introHtml"
            (valueChange)="setRich('introHtml', $event)"
          />
          @if (fe.all()['introHtml']; as introError) {
            <p class="field-error" role="alert">{{ introError }}</p>
          }
        </fieldset>

        <fieldset>
          <legend>תמונת פתיחה</legend>
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
              id="landing-alt"
              autocomplete="off"
              [attr.maxlength]="limits.landingAlt"
              [ngModel]="form().altHe"
              (ngModelChange)="set('altHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('altHe')"
            />
            <mat-hint>מתאר את התמונה לקוראי מסך</mat-hint>
            <mat-error>{{ fe.all()['altHe'] }}</mat-error>
          </mat-form-field>
        </fieldset>

        <fieldset>
          <legend>אילו מוצרים יוצגו</legend>
          <p class="muted">עד {{ limits.landingProducts }} מוצרים ברשת, בסדר "מומלץ".</p>
          <hga-product-source-field
            [categories]="categoryChoices()"
            [rooms]="roomChoices()"
            [promotions]="promotionChoices()"
            [unavailable]="sourceUnavailable()"
            [unavailableProductIds]="unavailableProducts()"
            [unavailableNote]="unavailableNote"
            [error]="fe.all()['source'] ?? ''"
            [loading]="loadingPicks()"
            [source]="form().source"
            (sourceChange)="setSource($event)"
            [picks]="picks()"
            (picksChange)="picks.set($event)"
          />
        </fieldset>

        <fieldset>
          <legend>טקסט סיום</legend>
          <hga-rich-text-editor
            mode="inline"
            label="טקסט סיום (לא חובה)"
            [value]="form().outroHtml"
            (valueChange)="setRich('outroHtml', $event)"
          />
          <p class="muted">מוצג מתחת לרשת המוצרים, למשל תנאי המבצע באותיות קטנות.</p>
          @if (fe.all()['outroHtml']; as outroError) {
            <p class="field-error" role="alert">{{ outroError }}</p>
          }
        </fieldset>

        <fieldset>
          <legend>פרסום</legend>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>סטטוס</mat-label>
            <mat-select [value]="form().status" (selectionChange)="setStatus($event.value)">
              @for (s of statuses; track s) {
                <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
              }
            </mat-select>
            <mat-hint>טיוטה לא מוצגת באתר גם בתוך טווח התאריכים</mat-hint>
          </mat-form-field>

          <p class="muted">שעון ישראל. מתחילת יום ההתחלה ועד סוף יום הסיום. ריק = בלי הגבלת תאריך.</p>
          <div class="date-grid">
            <hga-date-field
              label="תאריך התחלה"
              inputId="landing-start"
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
              inputId="landing-end"
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

          <mat-form-field subscriptSizing="dynamic">
            <mat-label>קישור אחרי הסיום</mat-label>
            <input
              matInput
              id="landing-ended-link"
              dir="ltr"
              autocomplete="off"
              [ngModel]="form().endedLinkUrl"
              (ngModelChange)="set('endedLinkUrl', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('endedLinkUrl')"
            />
            <mat-hint>
              לאן יוביל הכפתור בהודעה "המבצע הסתיים". כתובת באתר שמתחילה ב-/ או https://. ריק = דף הבית.
            </mat-hint>
            <mat-error>{{ fe.all()['endedLinkUrl'] }}</mat-error>
          </mat-form-field>
          <div class="shortcuts">
            <span class="muted">קיצורי דרך:</span>
            <button matButton="tonal" type="button" class="to-home" (click)="set('endedLinkUrl', '/')">דף הבית</button>
            @if (sourceShortcut(); as shortcut) {
              <button matButton="tonal" type="button" class="to-source" (click)="set('endedLinkUrl', shortcut.url)">
                {{ shortcut.label }}
              </button>
            }
          </div>

          <mat-form-field subscriptSizing="dynamic">
            <mat-label>תיאור לגוגל (לא חובה)</mat-label>
            <textarea
              matInput
              id="landing-meta"
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
          <label class="option">
            <input type="checkbox" [checked]="form().noindex" (change)="setNoindex($any($event.target).checked)" />
            <span>ללא אינדוקס בגוגל</span>
          </label>
        </fieldset>

        @if (problem()) {
          <p class="form-error" role="alert">{{ problem() }}</p>
        }
        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">שמירה</button>
          <a matButton routerLink="/content/landing">ביטול</a>
        </div>
      </form>
    }
  `,
})
export class LandingFormPage {
  /** "new" or the page's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly catalog = inject(CatalogApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly limits = CONTENT_LIMITS;
  protected readonly minDate = MIN_DATE;
  protected readonly maxDate = MAX_DATE;
  protected readonly stateLabels = LANDING_STATE_LABELS;
  protected readonly statusLabels = LANDING_STATUS_LABELS;
  protected readonly statuses: LandingStatus[] = ['draft', 'published'];
  protected readonly unavailableNote = LANDING_UNAVAILABLE_NOTE;
  protected readonly form = signal<LandingForm>(emptyLandingForm());
  protected readonly saved = signal<AdminLandingPage | null>(null);
  protected readonly picks = signal<RelatedPick[]>([]);
  protected readonly loadingPicks = signal(false);
  protected readonly categories = signal<AdminCategory[]>([]);
  protected readonly rooms = signal<AdminRoom[]>([]);
  protected readonly promotions = signal<AdminPromotionSource[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly previewing = signal(false);
  protected readonly previewUrl = signal('');
  protected readonly previewError = signal('');
  protected readonly isNew = computed(() => this.id() === 'new');
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.form()) !== this.baseline());

  protected readonly categoryChoices = computed<IdOption[]>(() => categoryOptions(this.categories()));
  protected readonly roomChoices = computed<IdOption[]>(() =>
    this.rooms().map((r) => ({ id: r.id, label: `${r.nameHe}${r.active ? '' : ' (מוסתר)'}` })),
  );
  protected readonly promotionChoices = computed(() => promotionOptions(this.promotions()));

  /** The API's "cannot show" marks describe the saved source; they apply only while the form still holds it. */
  private readonly sourceUnchanged = computed(() => {
    const saved = this.saved();
    return !!saved && JSON.stringify(saved.source) === JSON.stringify(this.form().source);
  });
  protected readonly sourceUnavailable = computed(() => this.sourceUnchanged() && !!this.saved()?.unavailable.source);
  protected readonly unavailableProducts = computed(() =>
    this.sourceUnchanged() ? (this.saved()?.unavailable.productIds ?? []) : [],
  );

  /** The ended-link shortcut to the category or room the grid comes from (the API gives the address). */
  protected readonly sourceShortcut = computed(() => {
    const url = this.saved()?.sourceLink;
    if (!url || !this.sourceUnchanged()) return null;
    return { url, label: url.startsWith('/room/') ? 'חדר המקור' : 'קטגוריית המקור' };
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
    void this.loadLookups();
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

  protected setRich(field: 'introHtml' | 'outroHtml', value: string) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.fe.clear(field);
  }

  protected setImage(field: 'image' | 'mobileImage', value: AdminContentImage | null) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.fe.clear('image');
  }

  protected setSource(source: ProductSource) {
    this.form.update((f) => ({ ...f, source }));
    this.fe.clear('source');
  }

  protected setStatus(status: LandingStatus) {
    this.form.update((f) => ({ ...f, status }));
  }

  protected setNoindex(noindex: boolean) {
    this.form.update((f) => ({ ...f, noindex }));
  }

  /** The preview address is signed for the saved page; it opens in a new tab with the opener link cut. */
  protected async preview() {
    const page = this.saved();
    if (!page || this.previewing()) return;
    this.previewing.set(true);
    this.previewUrl.set('');
    this.previewError.set('');
    try {
      const { url } = await this.api.landingPreview(page.id);
      // `noopener` in the features string would hide whether the tab opened, so the opener is cut afterwards instead.
      const tab = window.open(url, '_blank');
      if (tab) tab.opener = null;
      else this.previewUrl.set(url);
    } catch (e) {
      this.previewError.set(errorMessage(e));
    } finally {
      this.previewing.set(false);
    }
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    const { input, errors } = landingInput(this.form());
    this.fe.set(errors);
    this.problem.set('');
    if (!input) return;
    this.saving.set(true);
    try {
      const prev = this.saved();
      const saved = prev
        ? await this.api.updateLandingPage(prev.id, { ...input, expectedUpdatedAt: prev.updatedAt })
        : await this.api.createLandingPage(input);
      this.saved.set(saved);
      this.form.set(toLandingForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('עמוד הנחיתה נשמר', undefined, { duration: 2500 });
      // A new page moves to its own address, so "תצוגה מקדימה" is available right away.
      if (!prev) await this.router.navigate(['/content/landing', saved.id], { replaceUrl: true });
    } catch (e) {
      const r = refusal(e);
      const field = r.field ? SERVER_FIELDS[r.field] : undefined;
      if (field) this.fe.set({ [field]: r.message });
      else if (r.code === 'slug_taken') this.fe.set({ slug: r.message });
      else this.problem.set(r.message);
    } finally {
      this.saving.set(false);
    }
  }

  private async loadLookups() {
    const [structure, promotions] = await Promise.allSettled([this.catalog.structure(), this.api.promotionSources()]);
    // A picker that cannot load is just empty; the form still works.
    if (structure.status === 'fulfilled') {
      this.categories.set(structure.value.categories);
      this.rooms.set(structure.value.rooms);
    }
    if (promotions.status === 'fulfilled') this.promotions.set(promotions.value);
  }

  private loadSeq = 0;

  private async load(id: string) {
    const seq = ++this.loadSeq;
    this.loaded.set(false);
    this.loadError.set('');
    this.previewUrl.set('');
    this.previewError.set('');
    try {
      const page = id === 'new' ? null : await this.api.landingPage(Number(id));
      if (seq !== this.loadSeq) return;
      this.saved.set(page);
      this.form.set(page ? toLandingForm(page) : emptyLandingForm());
      this.picks.set([]);
      this.fe.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
      const source = this.form().source;
      if (source.kind === 'manual' && source.productIds.length) void this.loadPicks(source.productIds, seq);
    } catch (e) {
      if (seq === this.loadSeq) this.loadError.set(errorMessage(e));
    }
  }

  /** The names of the saved manual picks; the picker stays disabled meanwhile so saved ids are never dropped. */
  private async loadPicks(ids: number[], seq: number) {
    this.loadingPicks.set(true);
    const loaded = await loadSourcePicks(this.catalog, ids);
    if (seq === this.loadSeq) {
      this.picks.set(loaded);
      this.loadingPicks.set(false);
    }
  }
}
