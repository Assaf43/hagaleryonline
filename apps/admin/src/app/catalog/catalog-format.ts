import { FULFILLMENT_LABELS_HE, type AdminCategory, type FulfillmentMode } from '@hg/models';

/** Prices are agorot in the API and shekels on screen (decision: typed in ₪, VAT included). */
export function toShekels(agorot: number | null): number | null {
  return agorot === null ? null : agorot / 100;
}

export function toAgorot(shekels: number | null | undefined): number | null {
  return shekels === null || shekels === undefined || Number.isNaN(shekels) ? null : Math.round(shekels * 100);
}

const ILS = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPrice(agorot: number | null): string {
  return agorot === null ? '—' : ILS.format(agorot / 100);
}

const AMOUNT = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** 15000 agorot → "150": the number of `formatPrice` without the currency sign (for a signed amount, R20). */
export function formatAmount(agorot: number): string {
  return AMOUNT.format(agorot / 100);
}

export const FULFILLMENT_LABEL: Record<FulfillmentMode, string> = FULFILLMENT_LABELS_HE;

/** "corner-sofas" + "ALBA" → "alba-corner-sofa": the model name, then the category in the singular. */
export function suggestSlug(modelName: string, categorySlug: string | undefined): string {
  const model = toSlug(modelName);
  const type = (categorySlug ?? '').replace(/s$/, '');
  return [model, type].filter(Boolean).join('-');
}

export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "ספות › ספות פינתיות" — categories with their parent, sorted as in the tree. */
export function categoryOptions(categories: AdminCategory[]): { id: number; label: string; active: boolean }[] {
  const byParent = (parentId: number | null) => categories.filter((c) => c.parentId === parentId);
  const result: { id: number; label: string; active: boolean }[] = [];
  const walk = (parentId: number | null, prefix: string) => {
    for (const c of byParent(parentId)) {
      result.push({ id: c.id, label: prefix + c.nameHe, active: c.active });
      walk(c.id, `${prefix}${c.nameHe} › `);
    }
  };
  walk(null, '');
  return result;
}
