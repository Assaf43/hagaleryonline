import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucideChevronDown, LucideChevronUp, LucidePlus } from '@lucide/angular';
import { CONTENT_LIMITS, HOME_SECTION_LABELS_HE, type AdminHome, type HomeSectionKind } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { errorMessage } from '../core/errors';
import { PromotionsApi } from '../core/promotions.api';
import { ContentApi } from './content.api';
import { LEAVE_PROMPT } from './form-support';
import { HomeSectionDialog, type HomeLookups, type HomeSectionDialogData } from './home-section.dialog';
import {
  NO_UNAVAILABLE,
  SECTION_KINDS,
  SOURCE_KIND_LABELS,
  firstProblem,
  hasUnavailable,
  homeInput,
  homeSignature,
  moveItem,
  newSection,
  sectionName,
  toDrafts,
  type HomeDraft,
} from './home-sections';

const EMPTY_LOOKUPS: HomeLookups = { banners: [], categories: [], rooms: [], promotions: [] };

/** Kinds with nothing to set: adding one does not open the dialog. */
const NO_SETTINGS: HomeSectionKind[] = ['trust', 'rooms'];

/**
 * "דף הבית" (spec §5, NAV-05, decision 98, permission content.manage): the sections of the home page in order. Up / down
 * buttons, a visible switch, edit (a dialog per kind), add and remove; one save sends the whole list with the version
 * it was opened at (a newer save by someone else is a conflict). Settings the site cannot show now are marked.
 */
@Component({
  selector: 'hga-home-page',
  imports: [MatButtonModule, MatFormFieldModule, MatSelectModule, LucideChevronDown, LucideChevronUp, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./content.scss', './home.scss'],
  template: `
    <div class="head">
      <h1>דף הבית</h1>
      <button matButton="filled" type="button" class="save" [disabled]="saving() || !loaded()" (click)="save()">
        שמירה
      </button>
    </div>
    <p class="page-intro">
      האזורים מוצגים באתר לפי הסדר כאן. אזור מוסתר נשאר ברשימה אבל לא מוצג. השינויים נכנסים לתוקף רק אחרי "שמירה".
    </p>

    @if (loadError()) {
      <div class="form-error" role="alert">
        <p>{{ loadError() }}</p>
        <button matButton="outlined" type="button" (click)="load()">נסו שוב</button>
      </div>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <ol class="sections">
        @for (s of sections(); track s.key; let i = $index; let first = $first; let last = $last) {
          <li class="section" [class.hidden-section]="!s.visible">
            <div class="section-main">
              <span class="num" aria-hidden="true">{{ i + 1 }}</span>
              <div class="section-text">
                <strong class="name">{{ name(s) }}</strong>
                @if (s.titleHe) {
                  <span class="kind">{{ kinds[s.kind] }}</span>
                }
                <span class="meta">{{ summary(s) }}</span>
                @if (marked(s)) {
                  <span class="mark" role="note">{{ unavailableText(s) }}</span>
                }
              </div>
            </div>
            <div class="section-actions">
              <label class="option">
                <input type="checkbox" [checked]="s.visible" (change)="setVisible(s, $any($event.target).checked)" />
                <span>מוצג</span>
              </label>
              <button
                matIconButton
                type="button"
                class="up"
                [disabled]="first"
                (click)="move(i, -1)"
                [attr.aria-label]="'הזזה למעלה: ' + name(s)"
              >
                <svg lucideChevronUp></svg>
              </button>
              <button
                matIconButton
                type="button"
                class="down"
                [disabled]="last"
                (click)="move(i, 1)"
                [attr.aria-label]="'הזזה למטה: ' + name(s)"
              >
                <svg lucideChevronDown></svg>
              </button>
              <button
                matButton="outlined"
                type="button"
                class="edit"
                [attr.aria-label]="'עריכה: ' + name(s)"
                (click)="edit(s)"
              >
                עריכה
              </button>
              <button matButton type="button" class="remove" [attr.aria-label]="'הסרה: ' + name(s)" (click)="remove(s)">
                הסרה
              </button>
            </div>
          </li>
        }
      </ol>

      @if (sections().length < max) {
        <div class="add">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>סוג אזור חדש</mat-label>
            <mat-select [value]="newKind()" (selectionChange)="newKind.set($event.value)">
              @for (k of kindList; track k) {
                <mat-option [value]="k">{{ kinds[k] }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <button matButton="tonal" type="button" class="add-btn" (click)="add()">
            <svg lucidePlus></svg>
            הוספת אזור
          </button>
        </div>
      } @else {
        <p class="muted">הגעתם למספר האזורים המרבי ({{ max }}).</p>
      }

      @if (problem()) {
        <p class="form-error" role="alert">{{ problem() }}</p>
      }
      <div class="actions">
        <button matButton="filled" type="button" class="save" [disabled]="saving()" (click)="save()">שמירה</button>
        @if (dirty()) {
          <span class="muted" role="status">יש שינויים שלא נשמרו</span>
        }
      </div>
    }
  `,
})
export class HomePage {
  private readonly api = inject(ContentApi);
  private readonly catalog = inject(CatalogApi);
  private readonly promotionsApi = inject(PromotionsApi);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  protected readonly kinds = HOME_SECTION_LABELS_HE;
  protected readonly kindList = SECTION_KINDS;
  protected readonly max = CONTENT_LIMITS.homeSections;
  protected readonly sections = signal<HomeDraft[]>([]);
  protected readonly lookups = signal<HomeLookups>(EMPTY_LOOKUPS);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly newKind = signal<HomeSectionKind>('products');
  protected readonly name = sectionName;
  private readonly stamp = signal('');
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && homeSignature(this.sections()) !== this.baseline());

  constructor() {
    void this.load();
  }

  canLeave(): boolean {
    return !this.dirty() || confirm(LEAVE_PROMPT);
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  async load() {
    this.loadError.set('');
    try {
      const [home, banners, structure, promotions] = await Promise.allSettled([
        this.api.home(),
        this.api.banners(),
        this.catalog.structure(),
        this.promotionsApi.list(),
      ]);
      if (home.status === 'rejected') throw home.reason;
      // A picker that cannot load (e.g. no permission for promotions) is just empty; the list still works.
      this.lookups.set({
        banners: banners.status === 'fulfilled' ? banners.value : [],
        categories: structure.status === 'fulfilled' ? structure.value.categories : [],
        rooms: structure.status === 'fulfilled' ? structure.value.rooms : [],
        promotions: promotions.status === 'fulfilled' ? promotions.value : [],
      });
      this.apply(home.value);
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }

  private apply(home: AdminHome) {
    this.stamp.set(home.updatedAt);
    this.sections.set(toDrafts(home));
    this.baseline.set(homeSignature(this.sections()));
  }

  protected setVisible(s: HomeDraft, visible: boolean) {
    this.sections.update((list) => list.map((x) => (x.key === s.key ? { ...x, visible } : x)));
  }

  protected move(index: number, delta: -1 | 1) {
    this.sections.update((list) => moveItem(list, index, delta));
  }

  protected remove(s: HomeDraft) {
    if (!confirm(`להסיר את האזור "${sectionName(s)}" מדף הבית? השינוי נשמר רק אחרי "שמירה".`)) return;
    this.sections.update((list) => list.filter((x) => x.key !== s.key));
  }

  protected add() {
    if (this.sections().length >= this.max) return;
    const section = newSection(this.newKind());
    this.sections.update((list) => [...list, section]);
    if (!NO_SETTINGS.includes(section.kind)) this.edit(section, true);
  }

  /** `isNew`: cancelling the dialog of a section just added takes it back out (it would be invalid anyway). */
  protected edit(s: HomeDraft, isNew = false) {
    const data: HomeSectionDialogData = { draft: s, lookups: this.lookups() };
    const ref = this.dialog.open(HomeSectionDialog, {
      data,
      autoFocus: 'dialog',
      width: '40rem',
      maxWidth: '95vw',
    });
    ref.afterClosed().subscribe((edited: HomeDraft | undefined) => {
      if (edited)
        this.sections.update((list) =>
          list.map((x) => (x.key === s.key ? { ...edited, unavailable: NO_UNAVAILABLE } : x)),
        );
      else if (isNew) this.sections.update((list) => list.filter((x) => x.key !== s.key));
    });
  }

  protected summary(s: HomeDraft): string {
    const l = this.lookups();
    switch (s.kind) {
      case 'hero':
        return s.bannerIds.length
          ? `${s.bannerIds.length} באנרים: ${this.bannerNames(s.bannerIds)}`
          : 'בלי באנרים: מוצג הבאנר הקבוע של האתר';
      case 'banner_pair':
        return s.bannerIds.length ? `${s.bannerIds.length} באנרים: ${this.bannerNames(s.bannerIds)}` : 'בלי באנרים';
      case 'categories':
        return `${s.categoryIds.length} קטגוריות`;
      case 'products': {
        const src = s.source;
        const label =
          src.kind === 'category'
            ? `קטגוריה: ${l.categories.find((c) => c.id === src.id)?.nameHe ?? '#' + src.id}`
            : src.kind === 'room'
              ? `חדר: ${l.rooms.find((r) => r.id === src.id)?.nameHe ?? '#' + src.id}`
              : src.kind === 'promotion'
                ? `מבצע: ${l.promotions.find((p) => p.id === src.id)?.name ?? '#' + src.id}`
                : src.kind === 'manual'
                  ? `${SOURCE_KIND_LABELS.manual}: ${src.productIds.length} מוצרים`
                  : SOURCE_KIND_LABELS[src.kind];
        return `${label} · ${s.count} מוצרים בשורה`;
      }
      case 'trust':
        return 'שורת היתרונות הקבועה של האתר';
      case 'rooms':
        return 'כל החדרים וסוגי הרהיטים שלהם';
    }
  }

  private bannerNames(ids: number[]): string {
    const banners = this.lookups().banners;
    return ids.map((id) => banners.find((b) => b.id === id)?.nameHe ?? `#${id}`).join(', ');
  }

  protected marked(s: HomeDraft): boolean {
    return hasUnavailable(s.unavailable);
  }

  /** What of the section the site cannot show now. */
  protected unavailableText(s: HomeDraft): string {
    const u = s.unavailable;
    const parts: string[] = [];
    if (u.bannerIds.length) parts.push(`באנרים שלא מוצגים עכשיו: ${this.bannerNames(u.bannerIds)}`);
    if (u.categoryIds.length) parts.push(`${u.categoryIds.length} קטגוריות לא מוצגות (מוסתרות, ריקות או נמחקו)`);
    if (u.productIds.length) parts.push(`${u.productIds.length} מוצרים לא מוצגים (מוסתרים או נמחקו)`);
    if (u.source) parts.push('מקור המוצרים לא זמין (הוסתר, הסתיים או נמחק), והשורה לא מוצגת');
    return `לא מוצג באתר: ${parts.join(' · ')}`;
  }

  async save() {
    if (this.saving()) return;
    this.problem.set('');
    const bad = firstProblem(this.sections());
    if (bad) {
      this.problem.set(bad.index >= 0 ? `מקום ${bad.index + 1} בדף הבית: ${bad.message}` : bad.message);
      return;
    }
    this.saving.set(true);
    try {
      const saved = await this.api.saveHome(homeInput(this.sections(), this.stamp()));
      this.apply(saved);
      this.snack.open('דף הבית נשמר', undefined, { duration: 2500 });
    } catch (e) {
      this.problem.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }
}
