import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LucidePlus } from '@lucide/angular';
import { PROMOTION_KIND_LABELS_HE, PROMOTION_TARGET_LABELS_HE, type AdminPromotion } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { PromotionsApi } from '../core/promotions.api';
import { formatIsraelDate } from './israel-time';

export type PromotionState = 'active' | 'inactive' | 'ended' | 'exhausted' | 'scheduled';

export const STATE_LABELS: Record<PromotionState, string> = {
  active: 'פעיל',
  inactive: 'לא פעיל',
  ended: 'הסתיים',
  exhausted: 'נוצל',
  scheduled: 'מתוכנן',
};

/** Off, past its end, used up (paid uses reached the limit, R22), before its start, or running now. */
export function promotionState(p: AdminPromotion, now = Date.now()): PromotionState {
  if (!p.active) return 'inactive';
  if (p.endsAt && Date.parse(p.endsAt) < now) return 'ended';
  if (p.usageLimit !== null && p.usedCount >= p.usageLimit) return 'exhausted';
  if (p.startsAt && Date.parse(p.startsAt) > now) return 'scheduled';
  return 'active';
}

/** "1.12.2026 – 31.12.2026", "מ־1.12.2026", "עד 31.12.2026" or "ללא תאריכים", in Israel time. */
export function datesText(p: AdminPromotion): string {
  const start = p.startsAt ? formatIsraelDate(p.startsAt, 'start') : null;
  const end = p.endsAt ? formatIsraelDate(p.endsAt, 'end') : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `מ־${start}`;
  if (end) return `עד ${end}`;
  return 'ללא תאריכים';
}

/** "כל ההזמנה" or "קטגוריות: ספות, כורסאות" (product targets are rendered with their model names in the page). */
export function targetsText(p: AdminPromotion): string {
  if (p.target === 'order') return PROMOTION_TARGET_LABELS_HE.order;
  return `${PROMOTION_TARGET_LABELS_HE[p.target]}: ${p.targets.map((t) => t.modelName ?? t.nameHe).join(', ')}`;
}

/**
 * "מבצעים וקופונים" (spec §6, ADM-05, permission promotions.manage): every promotion, newest first, with its kind,
 * code, value, targets, dates (Israel time), uses against the limit and state; edit, or deactivate (there is no
 * delete). On phones each promotion is a card; from tablet width the cells line up.
 */
@Component({
  selector: 'hga-promotions-page',
  imports: [RouterLink, MatButtonModule, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './promotions.page.html',
  styleUrl: './promotions.page.scss',
})
export class PromotionsPage {
  private readonly api = inject(PromotionsApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly items = signal<AdminPromotion[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly kindLabels = PROMOTION_KIND_LABELS_HE;
  protected readonly targetLabels = PROMOTION_TARGET_LABELS_HE;
  protected readonly stateLabels = STATE_LABELS;
  protected readonly formatPrice = formatPrice;
  protected readonly datesText = datesText;
  protected readonly targetsText = targetsText;
  protected readonly state = (p: AdminPromotion) => promotionState(p);

  constructor() {
    void this.load();
  }

  protected retry() {
    void this.load();
  }

  async deactivate(p: AdminPromotion) {
    if (!confirm(`להשבית את "${p.name}"? אפשר להפעיל אותו שוב בעריכה.`)) return;
    this.busy.set(p.id);
    this.error.set('');
    try {
      const saved = await this.api.deactivate(p.id);
      this.items.update((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null);
      this.snack.open('המבצע הושבת', undefined, { duration: 2500 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(null);
    }
  }

  private async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.list());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
