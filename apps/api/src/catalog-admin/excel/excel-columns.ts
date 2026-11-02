import { FULFILLMENT_LABELS_HE, type AdminVariant, type FulfillmentMode, type ImportIssueCode } from '@hg/models';

/**
 * The Excel template (ADM-09, decisions 56–57): one row per variant, product columns repeated on
 * every row of the model. Headers are Hebrew and closed values are their Hebrew labels, exactly as
 * the admin shows them. The same definition writes the template and the export, and reads imports.
 */

export type ColumnKind = 'text' | 'int' | 'money' | 'cm' | 'yes_no' | 'list' | 'multi' | 'date';

export interface Column {
  key: string;
  header: string;
  level: 'product' | 'variant';
  kind: ColumnKind;
  /** Allowed Hebrew labels for list / multi columns. */
  options?: string[];
  /** For attribute columns: the attribute code. */
  attribute?: string;
  /** Shown in the instructions sheet. */
  help: string;
  width: number;
}

/** Everything the template needs from the catalog structure, as Hebrew labels. */
export interface ExcelLookups {
  /** "ספות › ספות פינתיות" → category */
  categories: Map<string, { id: number; slug: string }>;
  rooms: Map<string, number>;
  attributes: {
    code: string;
    nameHe: string;
    scope: 'product' | 'variant';
    /** label → code */
    values: Map<string, string>;
  }[];
}

export const MODEL_COLUMN = 'שם דגם';
export const SKU_COLUMN = 'מק"ט';
/** Rows with this model name are the template's example and are skipped on import. */
export const EXAMPLE_MODEL = 'EXAMPLE';
export const PRODUCTS_SHEET = 'מוצרים';
export const LISTS_SHEET = 'רשימות';
export const HELP_SHEET = 'הוראות';
export const YES = 'כן';
export const NO = 'לא';

const FULFILLMENT_BY_LABEL = new Map(
  Object.entries(FULFILLMENT_LABELS_HE).map(([mode, label]) => [label, mode as FulfillmentMode]),
);

export function buildColumns(lookups: ExcelLookups): Column[] {
  const attr = (scope: 'product' | 'variant') =>
    lookups.attributes
      .filter((a) => a.scope === scope)
      .map((a): Column => ({
        key: `attr:${a.code}`,
        header: a.nameHe,
        level: scope,
        kind: scope === 'product' ? 'multi' : 'list',
        options: [...a.values.keys()],
        attribute: a.code,
        help: scope === 'product' ? 'מאפיין של הדגם. כמה ערכים מפרידים בפסיק.' : 'אפשרות של הווריאנט, ערך אחד מהרשימה.',
        width: 16,
      }));
  const cm = (key: keyof AdminVariant, header: string, help: string): Column => ({
    key,
    header,
    level: 'variant',
    kind: 'cm',
    help,
    width: 11,
  });

  return [
    {
      key: 'modelName',
      header: MODEL_COLUMN,
      level: 'product',
      kind: 'text',
      help: 'חובה. שם הדגם באנגלית, למשל ALBA. כל השורות של אותו דגם הן הווריאנטים שלו.',
      width: 14,
    },
    {
      key: 'nameHe',
      header: 'שם המוצר',
      level: 'product',
      kind: 'text',
      help: 'חובה לדגם חדש. השם בעברית כפי שיופיע באתר.',
      width: 26,
    },
    {
      key: 'category',
      header: 'קטגוריה',
      level: 'product',
      kind: 'list',
      options: [...lookups.categories.keys()],
      help: 'חובה לדגם חדש. בוחרים מהרשימה.',
      width: 24,
    },
    {
      key: 'rooms',
      header: 'חדרים',
      level: 'product',
      kind: 'multi',
      options: [...lookups.rooms.keys()],
      help: 'כמה חדרים מפרידים בפסיק. ריק בדגם חדש: כל החדרים הפעילים.',
      width: 14,
    },
    ...attr('product'),
    { key: 'countryOfOrigin', header: 'ארץ ייצור', level: 'product', kind: 'text', help: 'לא חובה.', width: 12 },
    { key: 'warrantyMonths', header: 'אחריות (חודשים)', level: 'product', kind: 'int', help: 'מספר שלם.', width: 12 },
    { key: 'requiresAssembly', header: 'דורש הרכבה', level: 'product', kind: 'yes_no', help: 'כן או לא.', width: 11 },
    { key: 'careHe', header: 'הוראות טיפול', level: 'product', kind: 'text', help: 'לא חובה.', width: 24 },
    {
      key: 'sku',
      header: SKU_COLUMN,
      level: 'variant',
      kind: 'text',
      help: 'חובה. מזהה ייחודי של הווריאנט, באנגלית, ספרות ומקפים. לפיו מעדכנים שורה קיימת.',
      width: 22,
    },
    {
      key: 'price',
      header: 'מחיר (₪)',
      level: 'variant',
      kind: 'money',
      help: 'חובה לווריאנט חדש. בש"ח כולל מע"מ.',
      width: 11,
    },
    {
      key: 'compareAtPrice',
      header: 'מחיר לפני הנחה (₪)',
      level: 'variant',
      kind: 'money',
      help: 'רק במבצע, וגבוה מהמחיר. 0 מבטל את המחיר הקודם.',
      width: 14,
    },
    { key: 'stock', header: 'מלאי', level: 'variant', kind: 'int', help: 'מספר שלם. ריק בווריאנט חדש: 0.', width: 8 },
    {
      key: 'fulfillment',
      header: 'מצב אספקה',
      level: 'variant',
      kind: 'list',
      options: [...FULFILLMENT_BY_LABEL.keys()],
      help: 'בוחרים מהרשימה. ריק בווריאנט חדש: במלאי.',
      width: 16,
    },
    {
      key: 'leadTimeDays',
      header: 'זמן אספקה (ימי עסקים)',
      level: 'variant',
      kind: 'int',
      help: 'מקסימום ימי עסקים עד המסירה. ריק בווריאנט חדש: 14.',
      width: 14,
    },
    { key: 'productionDays', header: 'ימי ייצור', level: 'variant', kind: 'int', help: 'לייצור לפי הזמנה.', width: 10 },
    {
      key: 'expectedAt',
      header: 'תאריך הגעה',
      level: 'variant',
      kind: 'date',
      help: 'להזמנה מוקדמת. תאריך, למשל 31/12/2026.',
      width: 12,
    },
    {
      key: 'active',
      header: 'וריאנט פעיל',
      level: 'variant',
      kind: 'yes_no',
      help: 'כן או לא. ריק בווריאנט חדש: כן. (הצגת המוצר באתר נעשית רק בממשק.)',
      width: 11,
    },
    ...attr('variant'),
    cm('widthCm', 'רוחב (ס"מ)', 'חובה לווריאנט חדש.'),
    cm('depthCm', 'עומק (ס"מ)', 'חובה לווריאנט חדש.'),
    cm('heightCm', 'גובה (ס"מ)', 'חובה לווריאנט חדש.'),
    cm('weightKg', 'משקל (ק"ג)', 'לא חובה.'),
    cm('seatHeightCm', 'גובה מושב (ס"מ)', 'לספות וכורסאות.'),
    cm('seatDepthCm', 'עומק מושב (ס"מ)', 'לספות וכורסאות.'),
    cm('chaiseWidthCm', 'רוחב שזלונג (ס"מ)', 'לספות פינתיות ושזלונג.'),
    cm('chaiseDepthCm', 'עומק שזלונג (ס"מ)', 'לספות פינתיות ושזלונג.'),
  ];
}

/** A required column is marked with * in the template; the mark is ignored when reading. */
export function headerKey(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

export type CellValue = string | number | boolean | Date | null;
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ImportIssueCode; value: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (code: ImportIssueCode, raw: CellValue): Parsed<never> => ({ ok: false, code, value: String(raw) });

/** Numbers as typed in Hebrew Excel: "4,990", "4990 ₪", 4990. */
function toNumber(raw: CellValue): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const n = Number(raw.replace(/[,\s₪]/g, ''));
  return raw.trim() && Number.isFinite(n) ? n : null;
}

/**
 * One cell → a typed value. `null` means the cell is empty: on an existing product or variant
 * that leaves the stored value as it is (decision: an empty cell never deletes).
 */
export function parseCell(column: Column, raw: CellValue): Parsed<unknown> | null {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  switch (column.kind) {
    case 'text':
      return ok(String(raw).trim());
    case 'int': {
      const n = toNumber(raw);
      return n !== null && Number.isInteger(n) && n >= 0 ? ok(n) : fail('number', raw);
    }
    case 'money': {
      const n = toNumber(raw);
      return n !== null && n >= 0 ? ok(Math.round(n * 100)) : fail('number', raw);
    }
    case 'cm': {
      const n = toNumber(raw);
      return n !== null && n > 0 ? ok(Math.round(n * 10) / 10) : fail('number', raw);
    }
    case 'yes_no': {
      const text = String(raw).trim();
      if (raw === true || text === YES) return ok(true);
      if (raw === false || text === NO) return ok(false);
      return fail('yes_no', raw);
    }
    case 'date': {
      if (raw instanceof Date) return ok(raw.toISOString().slice(0, 10));
      const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(raw).trim());
      const iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(raw).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? ok(iso) : fail('date', raw);
    }
    case 'list': {
      const text = String(raw).trim();
      return column.options!.includes(text) ? ok(text) : fail('not_in_list', raw);
    }
    case 'multi': {
      const items = [
        ...new Set(
          String(raw)
            .split(/[,،;]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const unknown = items.find((i) => !column.options!.includes(i));
      return unknown === undefined ? ok(items) : fail('not_in_list', unknown);
    }
  }
}

export function fulfillmentOf(label: string): FulfillmentMode {
  return FULFILLMENT_BY_LABEL.get(label)!;
}

/** "ALBA" + "corner-sofas" → "alba-corner-sofa", as the admin form suggests it. */
export function slugFor(modelName: string, categorySlug: string): string {
  const model = modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return [model, categorySlug.replace(/s$/, '')].filter(Boolean).join('-');
}
