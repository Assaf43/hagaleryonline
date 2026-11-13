import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { ErrorStateMatcher } from '@angular/material/core';
import {
  DISCOUNT_TYPE_LABELS_HE,
  PROMOTION_KIND_LABELS_HE,
  PROMOTION_TARGET_LABELS_HE,
  normalizeCouponCode,
  type AdminPromotion,
  type DiscountType,
  type PromotionCategoryOption,
  type PromotionKind,
  type PromotionTarget,
  type RelatedPick,
} from '@hg/models';
import { ProductRelations } from '../catalog/product-relations';
import { errorMessage } from '../core/errors';
import { PromotionsApi } from '../core/promotions.api';
import {
  FIELD_IDS,
  FIELD_ORDER,
  MAX_DATE,
  MESSAGES,
  MIN_DATE,
  emptyForm,
  promotionInput,
  serverFieldOf,
  toForm,
  type PromotionErrors,
  type PromotionField,
  type PromotionForm,
} from './promotion-form';

type TextField =
  'name' | 'code' | 'value' | 'minSubtotal' | 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'usageLimit';

/**
 * Create or edit one promotion (`/promotions/new`, `/promotions/:id`; spec §6, ADM-05): kind, name (the customers
 * see it in the cart and the order), coupon code, percent or fixed amount in shekels, target (whole order,
 * categories with their sub-categories, or products via the related-products search), minimum, dates in Israel
 * time, usage limit (coupons), the welcome benefit (automatic only) and active. Errors show under their field and the first one gets the focus.
 */
@Component({
  selector: 'hga-promotion-form-page',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, ProductRelations],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './promotion-form.page.html',
  styleUrl: './promotion-form.page.scss',
})
export class PromotionFormPage {
  /** "new" or the promotion's id (route parameter). */
  readonly id = input.required<string>();

  private readonly api = inject(PromotionsApi);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly matchers = new Map<PromotionField, ErrorStateMatcher>();

  protected readonly ids = FIELD_IDS;
  protected readonly minDate = MIN_DATE;
  protected readonly maxDate = MAX_DATE;
  protected readonly kinds = Object.entries(PROMOTION_KIND_LABELS_HE) as [PromotionKind, string][];
  protected readonly types = Object.entries(DISCOUNT_TYPE_LABELS_HE) as [DiscountType, string][];
  protected readonly targets = Object.entries(PROMOTION_TARGET_LABELS_HE) as [PromotionTarget, string][];

  protected readonly form = signal<PromotionForm>(emptyForm());
  protected readonly errors = signal<PromotionErrors>({});
  protected readonly categories = signal<PromotionCategoryOption[]>([]);
  protected readonly saved = signal<AdminPromotion | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal(false);
  protected readonly problem = signal('');
  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly coupon = computed(() => this.form().kind === 'coupon');
  /** The form as loaded or last saved; leaving with other values asks first. */
  private readonly baseline = signal('');
  protected readonly dirty = computed(() => this.loaded() && JSON.stringify(this.form()) !== this.baseline());

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  canLeave(): boolean {
    return !this.dirty() || confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty()) event.preventDefault();
  }

  /** Marks a field invalid while the last check found a problem with it (the fields use ngModel, no form group). */
  protected matcher(field: PromotionField): ErrorStateMatcher {
    let m = this.matchers.get(field);
    if (!m) {
      m = { isErrorState: () => !!this.errors()[field] };
      this.matchers.set(field, m);
    }
    return m;
  }

  protected set(field: TextField, value: string) {
    this.form.update((f) => ({ ...f, [field]: value }));
    this.clear(field);
  }

  protected setKind(kind: PromotionKind) {
    this.form.update((f) => ({ ...f, kind }));
    this.clear('code');
    this.clear('usageLimit');
  }

  protected setType(discountType: DiscountType) {
    this.form.update((f) => ({ ...f, discountType }));
    this.clear('value');
  }

  protected setTarget(target: PromotionTarget) {
    this.form.update((f) => ({ ...f, target }));
    this.clear('targetIds');
  }

  protected toggleCategory(id: number, checked: boolean) {
    this.form.update((f) => ({
      ...f,
      categoryIds: checked ? [...f.categoryIds.filter((c) => c !== id), id] : f.categoryIds.filter((c) => c !== id),
    }));
    this.clear('targetIds');
  }

  protected setProducts(products: RelatedPick[]) {
    this.form.update((f) => ({ ...f, products }));
    this.clear('targetIds');
  }

  protected setActive(active: boolean) {
    this.form.update((f) => ({ ...f, active }));
  }

  protected setWelcome(isWelcome: boolean) {
    this.form.update((f) => ({ ...f, isWelcome }));
  }

  /** The code as it will be saved, once the field is left. */
  protected normalizeCode() {
    if (this.form().code.trim()) this.form.update((f) => ({ ...f, code: normalizeCouponCode(f.code) }));
  }

  async save(event?: Event) {
    event?.preventDefault();
    if (this.saving()) return;
    const { input, errors } = promotionInput(this.form());
    this.errors.set(errors);
    this.problem.set('');
    if (!input) {
      this.focus(FIELD_ORDER.find((f) => errors[f])!);
      return;
    }
    this.saving.set(true);
    try {
      const saved = this.isNew() ? await this.api.create(input) : await this.api.update(Number(this.id()), input);
      this.saved.set(saved);
      this.form.set(toForm(saved));
      this.baseline.set(JSON.stringify(this.form()));
      this.snack.open('המבצע נשמר', undefined, { duration: 2500 });
      await this.router.navigateByUrl('/promotions');
    } catch (e) {
      this.refused(e);
    } finally {
      this.saving.set(false);
    }
  }

  private refused(e: unknown) {
    const body = (e instanceof HttpErrorResponse ? e.error : null) as { code?: string; field?: string } | null;
    const field = serverFieldOf(body?.field);
    if (field && (body?.code === 'duplicate' || body?.code === 'invalid')) {
      const text =
        body.code === 'duplicate'
          ? MESSAGES.codeTaken
          : field === 'targetIds'
            ? MESSAGES.targetGone
            : 'הערך לא תקין. בדקו אותו ונסו שוב.';
      this.errors.set({ [field]: text });
      this.focus(field);
      return;
    }
    this.problem.set(errorMessage(e));
  }

  private clear(field: PromotionField) {
    if (!this.errors()[field]) return;
    this.errors.update((all) => {
      const next = { ...all };
      delete next[field];
      return next;
    });
  }

  /** After the errors render, so the control's aria-describedby already points at its message. */
  private focus(field: PromotionField) {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${FIELD_IDS[field]}`)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const [categories, promotion] = await Promise.all([
        this.api.categories(),
        id === 'new' ? Promise.resolve(null) : this.api.get(Number(id)),
      ]);
      this.categories.set(categories);
      this.saved.set(promotion);
      this.form.set(promotion ? toForm(promotion) : emptyForm());
      this.errors.set({});
      this.baseline.set(JSON.stringify(this.form()));
      this.loaded.set(true);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }
}
