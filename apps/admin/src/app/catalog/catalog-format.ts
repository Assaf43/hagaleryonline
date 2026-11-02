import type { AdminCategory, FulfillmentMode } from '@hg/models';

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

export const FULFILLMENT_LABEL: Record<FulfillmentMode, string> = {
  in_stock: 'במלאי',
  pre_order: 'בהזמנה מוקדמת',
  made_to_order: 'בייצור לפי הזמנה',
  out_of_stock: 'אזל',
};

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
