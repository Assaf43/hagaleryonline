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
import { LucideArrowDown, LucideArrowUp, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { CONTENT_LIMITS, type AdminFaqGroup, type AdminFaqGroupInput } from '@hg/models';
import { errorMessage } from '../core/errors';
import { RichTextEditor } from '../shared/rich-text-editor';
import { ContentApi } from './content.api';
import { FieldErrors, LEAVE_PROMPT, refusal } from './form-support';

/** One question while editing. `key` is local (it keeps each editor in place while items move). */
export interface FaqItemDraft {
  key: number;
  id?: number;
  questionHe: string;
  answerHtml: string;
  published: boolean;
}

export interface FaqGroupDraft {
  titleHe: string;
  sortOrder: string;
  published: boolean;
  items: FaqItemDraft[];
}

/** Moves item `from` one place toward `to` (up = -1, down = +1); out of range returns the same list. */
export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The API input, or the errors that stop it (keyed `titleHe`, `sortOrder`, `items.<i>.questionHe|answerHtml`). */
export function faqGroupInput(d: FaqGroupDraft): { input: AdminFaqGroupInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const title = d.titleHe.trim();
  if (!title || title.length > CONTENT_LIMITS.title)
    errors['titleHe'] = `יש למלא כותרת (עד ${CONTENT_LIMITS.title} תווים).`;
  if (!/^\d{1,6}$/.test(d.sortOrder.trim())) errors['sortOrder'] = 'הסדר חייב להיות מספר שלם, 0 ומעלה.';
  if (d.items.length > CONTENT_LIMITS.faqItems) errors['items'] = `עד ${CONTENT_LIMITS.faqItems} שאלות בקבוצה.`;
  d.items.forEach((it, i) => {
    const q = it.questionHe.trim();
    if (!q || q.length > CONTENT_LIMITS.faqQuestion) {
      errors[`items.${i}.questionHe`] = `יש למלא את השאלה (עד ${CONTENT_LIMITS.faqQuestion} תווים).`;
    }
    if (!it.answerHtml.trim()) errors[`items.${i}.answerHtml`] = 'יש למלא את התשובה.';
  });
  if (Object.keys(errors).length) return { input: null, errors };
  return {
    input: {
      titleHe: title,
      sortOrder: Number(d.sortOrder.trim()),
      published: d.published,
      items: d.items.map((it) => ({
        ...(it.id === undefined ? {} : { id: it.id }),
        questionHe: it.questionHe.trim(),
        answerHtml: it.answerHtml,
        published: it.published,
      })),
    },
    errors,
  };
}

/** Create or edit one FAQ group with all its questions (`/content/faq/new`, `/:id`); the item order is the list order. */
@Component({
  selector: 'hga-faq-group-form-page',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    RichTextEditor,
    LucideArrowDown,
    LucideArrowUp,
    LucidePlus,
    LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './content.scss',
  template: `
    <a class="back" routerLink="/content/faq">חזרה לשאלות ותשובות</a>
    <h1>{{ isNew() ? 'קבוצה חדשה' : 'עריכת קבוצה' }}</h1>

    @if (loadError()) {
      <p class="form-error" role="alert">{{ loadError() }}</p>
    } @else if (!loaded()) {
      <p class="page-intro" role="status">טוען…</p>
    } @else {
      <form class="panel" novalidate (submit)="save($event)">
        <div class="fields">
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>כותרת הקבוצה</mat-label>
            <input
              matInput
              id="faq-title"
              autocomplete="off"
              [attr.maxlength]="limits.title"
              [ngModel]="draft().titleHe"
              (ngModelChange)="setGroup('titleHe', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('titleHe')"
            />
            <mat-error>{{ fe.all()['titleHe'] }}</mat-error>
          </mat-form-field>
          <mat-form-field subscriptSizing="dynamic">
            <mat-label>סדר</mat-label>
            <input
              matInput
              id="faq-order"
              inputmode="numeric"
              autocomplete="off"
              [ngModel]="draft().sortOrder"
              (ngModelChange)="setGroup('sortOrder', $event)"
              [ngModelOptions]="{ standalone: true }"
              [errorStateMatcher]="fe.matcher('sortOrder')"
            />
            <mat-hint>מספר נמוך מוצג קודם</mat-hint>
            <mat-error>{{ fe.all()['sortOrder'] }}</mat-error>
          </mat-form-field>
        </div>

        <label class="option">
          <input type="checkbox" [checked]="draft().published" (change)="setPublished($any($event.target).checked)" />
          <span>מפורסם</span>
        </label>

        <h2>שאלות</h2>
        @if (fe.all()['items']; as itemsError) {
          <p class="field-error" role="alert">{{ itemsError }}</p>
        }
        <ol class="items">
          @for (it of draft().items; track it.key; let i = $index; let first = $first; let last = $last) {
            <li class="item">
              <div class="item-head">
                <h3>
                  שאלה <bdi>{{ i + 1 }}</bdi>
                </h3>
                <button
                  matIconButton
                  type="button"
                  class="up"
                  [disabled]="first"
                  [attr.aria-label]="'הזזת שאלה ' + (i + 1) + ' למעלה'"
                  (click)="move(i, -1)"
                >
                  <svg lucideArrowUp></svg>
                </button>
                <button
                  matIconButton
                  type="button"
                  class="down"
                  [disabled]="last"
                  [attr.aria-label]="'הזזת שאלה ' + (i + 1) + ' למטה'"
                  (click)="move(i, 1)"
                >
                  <svg lucideArrowDown></svg>
                </button>
                <button
                  matIconButton
                  type="button"
                  class="remove"
                  [attr.aria-label]="'מחיקת שאלה ' + (i + 1)"
                  (click)="removeItem(i)"
                >
                  <svg lucideTrash2></svg>
                </button>
              </div>
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>השאלה</mat-label>
                <input
                  matInput
                  autocomplete="off"
                  [attr.maxlength]="limits.faqQuestion"
                  [ngModel]="it.questionHe"
                  (ngModelChange)="setItem(i, 'questionHe', $event)"
                  [ngModelOptions]="{ standalone: true }"
                  [errorStateMatcher]="fe.matcher('items.' + i + '.questionHe')"
                />
                <mat-error>{{ fe.all()['items.' + i + '.questionHe'] }}</mat-error>
              </mat-form-field>
              <hga-rich-text-editor
                mode="inline"
                [label]="'התשובה לשאלה ' + (i + 1)"
                [value]="it.answerHtml"
                (valueChange)="setItem(i, 'answerHtml', $event)"
              />
              @if (fe.all()['items.' + i + '.answerHtml']; as answerError) {
                <p class="field-error" role="alert">{{ answerError }}</p>
              }
              <label class="option">
                <input
                  type="checkbox"
                  [checked]="it.published"
                  (change)="setItem(i, 'published', $any($event.target).checked)"
                />
                <span>השאלה מפורסמת</span>
              </label>
            </li>
          } @empty {
            <li class="muted">אין שאלות בקבוצה. אפשר להוסיף שאלה בכפתור "הוספת שאלה".</li>
          }
        </ol>
        <div>
          <button matButton="outlined" type="button" class="add-item" (click)="addItem()">
            <svg lucidePlus></svg>
            הוספת שאלה
          </button>
        </div>

        @if (problem()) {
          <p class="form-error" role="alert">{{ problem() }}</p>
        }
        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">שמירה</button>
          <a matButton routerLink="/content/faq">ביטול</a>
        </div>
      </form>
    }
  `,
})
export class FaqGroupFormPage {
  /** "new" or the group's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(ContentApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  protected readonly fe = new FieldErrors();
  protected readonly limits = CONTENT_LIMITS;
  protected readonly draft = signal<FaqGroupDraft>({ titleHe: '', sortOrder: '0', published: true, items: [] });
  protected readonly saved = signal<AdminFaqGroup | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly isNew = computed(() => this.id() === 'new');
  private nextKey = 1;
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && this.snapshot() !== this.baseline());

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private snapshot(): string {
    const d = this.draft();
    return JSON.stringify({ ...d, items: d.items.map(({ key: _key, ...rest }) => rest) });
  }

  canLeave(): boolean {
    return !this.dirty() || confirm(LEAVE_PROMPT);
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  protected setGroup(field: 'titleHe' | 'sortOrder', value: string) {
    this.draft.update((d) => ({ ...d, [field]: value }));
    this.fe.clear(field);
  }

  protected setPublished(published: boolean) {
    this.draft.update((d) => ({ ...d, published }));
  }

  protected setItem<K extends 'questionHe' | 'answerHtml' | 'published'>(
    index: number,
    field: K,
    value: FaqItemDraft[K],
  ) {
    this.draft.update((d) => ({ ...d, items: d.items.map((it, i) => (i === index ? { ...it, [field]: value } : it)) }));
    this.fe.clear(`items.${index}.${field}`);
  }

  protected addItem() {
    this.draft.update((d) => ({
      ...d,
      items: [...d.items, { key: this.nextKey++, questionHe: '', answerHtml: '', published: true }],
    }));
  }

  protected removeItem(index: number) {
    this.draft.update((d) => ({ ...d, items: d.items.filter((_, i) => i !== index) }));
    this.fe.set({});
  }

  protected move(index: number, delta: -1 | 1) {
    this.draft.update((d) => ({ ...d, items: moveItem(d.items, index, delta) }));
    this.fe.set({});
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    this.problem.set('');
    const { input, errors } = faqGroupInput(this.draft());
    this.fe.set(errors);
    if (!input) return;
    this.saving.set(true);
    try {
      const prev = this.saved();
      const saved = prev
        ? await this.api.updateFaqGroup(prev.id, { ...input, expectedUpdatedAt: prev.updatedAt })
        : await this.api.createFaqGroup(input);
      this.saved.set(saved);
      this.apply(saved);
      this.snack.open('הקבוצה נשמרה', undefined, { duration: 2500 });
      await this.router.navigateByUrl('/content/faq');
    } catch (e) {
      const r = refusal(e);
      if (
        r.field &&
        (r.field === 'titleHe' || r.field === 'sortOrder' || /^items\.\d+\.(questionHe|answerHtml)$/.test(r.field))
      ) {
        this.fe.set({ [r.field]: r.message });
      } else {
        this.problem.set(r.message);
      }
    } finally {
      this.saving.set(false);
    }
  }

  private apply(g: AdminFaqGroup | null) {
    this.draft.set(
      g
        ? {
            titleHe: g.titleHe,
            sortOrder: String(g.sortOrder),
            published: g.published,
            items: g.items.map((it) => ({
              key: this.nextKey++,
              id: it.id,
              questionHe: it.questionHe,
              answerHtml: it.answerHtml,
              published: it.published,
            })),
          }
        : { titleHe: '', sortOrder: '0', published: true, items: [] },
    );
    this.baseline.set(this.snapshot());
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const g = id === 'new' ? null : await this.api.faqGroup(Number(id));
      this.saved.set(g);
      this.apply(g);
      this.fe.set({});
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}
