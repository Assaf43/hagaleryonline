import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  BRAND,
  FULFILLMENT_LABELS_HE,
  type AdminProduct,
  type AdminProductInput,
  type AdminVariant,
  type ImportIssue,
  type ImportReport,
  type ImportSummary,
} from '@hg/models';
import { AttributeScope, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { CacheStore } from '../../cache/cache-store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogError } from '../catalog-errors.js';
import { parseProductInput } from '../catalog-input.js';
import { ProductsAdminService, uniqueToDuplicate, type Meta } from '../products-admin.service.js';
import {
  EXAMPLE_MODEL,
  HELP_SHEET,
  LISTS_SHEET,
  MODEL_COLUMN,
  NO,
  PRODUCTS_SHEET,
  SKU_COLUMN,
  YES,
  buildColumns,
  fulfillmentOf,
  headerKey,
  parseCell,
  slugFor,
  type CellValue,
  type Column,
  type ExcelLookups,
} from './excel-columns.js';

export const MAX_ROWS = 5000;
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Range-wide drop-downs: present at runtime in exceljs 4, missing from its type definitions. */
type DataValidations = { add(range: string, validation: ExcelJS.DataValidation): void };

/** One spreadsheet row, parsed: column key → value (empty cells are absent). */
interface SheetRow {
  row: number;
  cells: Map<string, unknown>;
}

/** Stops the import transaction: with problems to report, or after a dry run. */
class Rollback extends Error {
  constructor(
    readonly errors: ImportIssue[],
    readonly summary: ImportSummary,
  ) {
    super('rollback');
  }
}

const emptySummary = (rows: number): ImportSummary => ({
  rows,
  productsCreated: 0,
  productsUpdated: 0,
  productsUnchanged: 0,
  variantsCreated: 0,
  variantsUpdated: 0,
  priceChanges: 0,
});

/**
 * Excel template, export and import (Phase 2c, ADM-09, decisions 56–57). The import checks the
 * whole file first and saves nothing while there are errors; then every product is saved through
 * the same code as the admin form, all in one transaction. It only creates and updates: products
 * missing from the file are left alone, an empty cell keeps the stored value, and new products
 * start hidden (decision 60).
 */
@Injectable()
export class ExcelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsAdminService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
  ) {}

  async lookups(tx: Prisma.TransactionClient = this.prisma): Promise<ExcelLookups> {
    const [categories, rooms, attributes] = await Promise.all([
      tx.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      tx.room.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      tx.attribute.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: { values: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
      }),
    ]);
    // "ספות › ספות פינתיות": the same labels as the category picker in the admin.
    const byParent = (parentId: number | null) => categories.filter((c) => c.parentId === parentId);
    const categoryLabels = new Map<string, { id: number; slug: string }>();
    const walk = (parentId: number | null, prefix: string) => {
      for (const c of byParent(parentId)) {
        categoryLabels.set(prefix + c.nameHe, { id: c.id, slug: c.slug });
        walk(c.id, `${prefix}${c.nameHe} › `);
      }
    };
    walk(null, '');
    return {
      categories: categoryLabels,
      rooms: new Map(rooms.map((r) => [r.nameHe, r.id])),
      attributes: attributes.map((a) => ({
        code: a.code,
        nameHe: a.nameHe,
        scope: a.scope === AttributeScope.PRODUCT ? 'product' : 'variant',
        values: new Map(a.values.map((v) => [v.labelHe, v.code])),
      })),
    };
  }

  // ---------- Template and export ----------

  /** An empty template with one example row (skipped on import). */
  async template(): Promise<Buffer> {
    const lookups = await this.lookups();
    const columns = buildColumns(lookups);
    const sofaCategory =
      [...lookups.categories.keys()].find((l) => l.includes('›')) ?? [...lookups.categories.keys()][0];
    const first = (code: string) => [...(lookups.attributes.find((a) => a.code === code)?.values.keys() ?? [])][0];
    const example: Record<string, CellValue> = {
      modelName: EXAMPLE_MODEL,
      nameHe: 'שורת דוגמה. היא לא נקלטת, אפשר למחוק אותה',
      category: sofaCategory ?? null,
      rooms: [...lookups.rooms.keys()][0] ?? null,
      sku: 'EXAMPLE-220-BEIGE',
      price: 3990,
      stock: 2,
      fulfillment: FULFILLMENT_LABELS_HE.in_stock,
      leadTimeDays: 14,
      active: YES,
      requiresAssembly: NO,
      warrantyMonths: 12,
      widthCm: 220,
      depthCm: 95,
      heightCm: 85,
      'attr:color': first('color') ?? null,
    };
    return this.workbook(columns, [], example);
  }

  /** The whole catalog in the template's format — edit it and import it back. */
  async export(): Promise<Buffer> {
    const lookups = await this.lookups();
    const columns = buildColumns(lookups);
    const categoryLabel = new Map([...lookups.categories].map(([label, c]) => [c.id, label]));
    const roomLabel = new Map([...lookups.rooms].map(([label, id]) => [id, label]));
    const valueLabel = (attribute: string, code: string) =>
      [...(lookups.attributes.find((a) => a.code === attribute)?.values ?? [])].find(([, c]) => c === code)?.[0] ??
      code;

    const ids = await this.prisma.product.findMany({ orderBy: { modelName: 'asc' }, select: { id: true } });
    const rows: Record<string, CellValue>[] = [];
    for (const { id } of ids) {
      const p = await this.products.getInTx(this.prisma, id);
      const productCells: Record<string, CellValue> = {
        modelName: p.modelName,
        nameHe: p.nameHe,
        category: categoryLabel.get(p.categoryId) ?? null,
        rooms: p.roomIds.map((r) => roomLabel.get(r)).join(', '),
        countryOfOrigin: p.countryOfOrigin,
        warrantyMonths: p.warrantyMonths,
        requiresAssembly: p.requiresAssembly ? YES : NO,
        careHe: p.careHe,
      };
      for (const [attribute, values] of Object.entries(p.attributes))
        productCells[`attr:${attribute}`] = values.map((v) => valueLabel(attribute, v)).join(', ');
      for (const v of p.variants) {
        const row: Record<string, CellValue> = {
          ...productCells,
          sku: v.sku,
          price: v.price / 100,
          compareAtPrice: v.compareAtPrice === null ? null : v.compareAtPrice / 100,
          stock: v.stock,
          fulfillment: FULFILLMENT_LABELS_HE[v.fulfillment],
          leadTimeDays: v.leadTimeDays,
          productionDays: v.productionDays,
          expectedAt: v.expectedAt ? v.expectedAt.split('-').reverse().join('/') : null,
          active: v.active ? YES : NO,
        };
        for (const key of DIMENSIONS) row[key] = v[key];
        for (const [attribute, value] of Object.entries(v.options))
          row[`attr:${attribute}`] = valueLabel(attribute, value);
        rows.push(row);
      }
    }
    return this.workbook(columns, rows);
  }

  private async workbook(
    columns: Column[],
    rows: Record<string, CellValue>[],
    example?: Record<string, CellValue>,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = BRAND.name;
    const sheet = wb.addWorksheet(PRODUCTS_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    const required = new Set([MODEL_COLUMN, SKU_COLUMN]);
    sheet.columns = columns.map((c) => ({
      header: required.has(c.header) ? `${c.header} *` : c.header,
      key: c.key,
      width: c.width,
    }));
    const head = sheet.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', wrapText: true };
    head.height = 32;
    columns.forEach((c, i) => {
      head.getCell(i + 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: c.level === 'product' ? 'FFF3E3DA' : 'FFE6EEF3' },
      };
    });
    if (example) {
      const row = sheet.addRow(example);
      row.font = { italic: true, color: { argb: 'FF8A8A8A' } };
    }
    for (const r of rows) sheet.addRow(r);

    // Closed lists live on a hidden sheet; each list column gets a drop-down that points at it.
    const lists = wb.addWorksheet(LISTS_SHEET, { state: 'hidden' });
    const lastRow = Math.max(rows.length + 500, 1000);
    let listIndex = 0;
    const listColumns: [Column, string[]][] = [
      ...columns.filter((c) => c.options).map((c): [Column, string[]] => [c, c.options!]),
      ...columns.filter((c) => c.kind === 'yes_no').map((c): [Column, string[]] => [c, [YES, NO]]),
    ];
    for (const [column, options] of listColumns) {
      listIndex++;
      const letter = lists.getColumn(listIndex).letter;
      lists.getCell(`${letter}1`).value = column.header;
      options.forEach((o, i) => (lists.getCell(`${letter}${i + 2}`).value = o));
      const target = sheet.getColumn(column.key).letter;
      (sheet as unknown as { dataValidations: DataValidations }).dataValidations.add(`${target}2:${target}${lastRow}`, {
        type: 'list',
        allowBlank: true,
        formulae: [`'${LISTS_SHEET}'!$${letter}$2:$${letter}$${options.length + 1}`],
        // Product attributes and rooms may hold several values separated by commas.
        showErrorMessage: column.kind !== 'multi',
        errorTitle: 'ערך לא ברשימה',
        error: 'בחרו ערך מהרשימה הנפתחת.',
      });
    }

    const help = wb.addWorksheet(HELP_SHEET, { views: [{ rightToLeft: true }] });
    help.columns = [
      { header: 'עמודה', key: 'column', width: 26 },
      { header: 'הסבר', key: 'help', width: 90 },
    ];
    help.getRow(1).font = { bold: true };
    for (const line of GENERAL_HELP) help.addRow({ column: '', help: line });
    help.addRow({});
    for (const c of columns)
      help.addRow({ column: c.header, help: `${c.level === 'product' ? 'דגם' : 'וריאנט'}. ${c.help}` });

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ---------- Import ----------

  /** `apply: false` checks the file and reports what would change; `true` also saves. */
  async run(file: Buffer, meta: Meta, apply: boolean): Promise<ImportReport> {
    const lookups = await this.lookups();
    const columns = buildColumns(lookups);
    const read = await readSheet(file, columns);
    if ('error' in read) return { applied: false, errors: [read.error], summary: emptySummary(0) };
    const { rows, header } = read;
    const errors = [...read.errors];
    const summary = emptySummary(rows.length);
    if (rows.length === 0) errors.push({ row: null, column: null, code: 'no_rows' });
    if (rows.length > MAX_ROWS)
      errors.push({ row: null, column: null, code: 'too_many_rows', value: String(MAX_ROWS) });

    const productKeys = new Set(
      columns.filter((c) => c.level === 'product' && c.key !== 'modelName').map((c) => c.key),
    );
    const groups = groupByModel(rows, header, productKeys, errors);
    if (errors.length) return { applied: false, errors, summary };

    try {
      await this.prisma
        .$transaction(
          async (tx) => {
            await this.importGroups(tx, groups, lookups, header, summary, meta);
            if (!apply) throw new Rollback([], summary);
            await this.audit.record(
              { ...meta, action: 'catalog.import', entityType: 'catalog', after: { ...summary } },
              tx,
            );
          },
          { timeout: 120_000 },
        )
        .catch(uniqueToDuplicate);
    } catch (e) {
      if (e instanceof Rollback) return { applied: false, errors: e.errors, summary: e.summary };
      throw e;
    }
    await this.cache.invalidate('catalog:');
    return { applied: true, errors: [], summary };
  }

  private async importGroups(
    tx: Prisma.TransactionClient,
    groups: Map<string, SheetRow[]>,
    lookups: ExcelLookups,
    header: Map<string, string>,
    summary: ImportSummary,
    meta: Meta,
  ) {
    const models = [...groups.keys()];
    const existing = new Map(
      (await tx.product.findMany({ where: { modelName: { in: models } }, select: { id: true, modelName: true } })).map(
        (p) => [p.modelName, p.id],
      ),
    );
    const skus = [...groups.values()].flat().map((r) => r.cells.get('sku') as string);
    const owners = new Map(
      (
        await tx.variant.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, product: { select: { modelName: true } } },
        })
      ).map((v) => [v.sku, v.product.modelName]),
    );

    // Everything that can be told from the file and the database, for every row, before saving anything.
    const errors: ImportIssue[] = [];
    const plans: { model: string; rows: SheetRow[]; current: AdminProduct | null }[] = [];
    for (const [model, rows] of groups) {
      for (const r of rows) {
        const owner = owners.get(r.cells.get('sku') as string);
        if (owner && owner !== model)
          errors.push({
            row: r.row,
            column: header.get('sku')!,
            code: 'sku_taken',
            value: `${r.cells.get('sku') as string} (${owner})`,
          });
      }
      const id = existing.get(model);
      const current = id ? await this.products.getInTx(tx, id) : null;
      const known = new Set(current?.variants.map((v) => v.sku));
      const need = (r: SheetRow, keys: string[]) => {
        for (const key of keys)
          if (!r.cells.has(key)) errors.push({ row: r.row, column: header.get(key) ?? key, code: 'required' });
      };
      if (!current) need(rows[0], ['nameHe', 'category']);
      for (const r of rows)
        if (!known.has(r.cells.get('sku') as string)) need(r, ['price', 'widthCm', 'depthCm', 'heightCm']);
      plans.push({ model, rows, current });
    }
    if (errors.length) throw new Rollback(errors, summary);

    for (const { model, rows, current } of plans) {
      const { input, rowOfVariant } = await buildInput(tx, model, rows, current, lookups);
      try {
        const parsed = parseProductInput(input);
        if (current) {
          const before = parseProductInput(formOf(current));
          if (sameProduct(before, parsed)) {
            summary.productsUnchanged++;
            continue;
          }
          const old = new Map(before.variants.map((v) => [v.sku, v]));
          for (const v of parsed.variants) {
            const was = old.get(v.sku);
            if (!was) summary.variantsCreated++;
            else if (JSON.stringify(was) !== JSON.stringify(v)) {
              summary.variantsUpdated++;
              if (was.price !== v.price) summary.priceChanges++;
            }
          }
          summary.productsUpdated++;
        } else {
          summary.productsCreated++;
          summary.variantsCreated += parsed.variants.length;
        }
        await this.products.saveInTx(tx, current?.id ?? null, parsed, meta);
      } catch (e) {
        if (!(e instanceof CatalogError)) throw e;
        throw new Rollback([rejected(e, rows, rowOfVariant, header)], summary);
      }
    }
  }
}

const DIMENSIONS = [
  'widthCm',
  'depthCm',
  'heightCm',
  'weightKg',
  'seatHeightCm',
  'seatDepthCm',
  'chaiseWidthCm',
  'chaiseDepthCm',
] as const;

const GENERAL_HELP = [
  'שורה אחת לכל וריאנט (מידה, צבע, בד). כל השורות עם אותו שם דגם שייכות לאותו מוצר.',
  'עמודות של הדגם (רקע כתום) חוזרות בכל שורה של הדגם, ובכולן צריך להיות אותו ערך, או להשאיר ריק.',
  'דגם קיים מזוהה לפי שם הדגם, ווריאנט קיים לפי המק"ט. תא ריק משאיר את הערך הקיים כמו שהוא.',
  'הייבוא רק מוסיף ומעדכן. מוצרים שלא מופיעים בקובץ לא נמחקים ולא מוסתרים.',
  'מוצר חדש נשמר מוסתר. את התמונות והתיאור משלימים בממשק, ושם גם מציגים אותו באתר.',
  'קודם מעלים את הקובץ לבדיקה. אם יש שגיאות, שום דבר לא נשמר, ומקבלים רשימה לפי שורה ועמודה.',
  `השורה עם שם הדגם ${EXAMPLE_MODEL} היא דוגמה ולא נקלטת.`,
];

/** The sheet's header row → which column is where; every data row → parsed cells. */
async function readSheet(
  file: Buffer,
  columns: Column[],
): Promise<{ rows: SheetRow[]; header: Map<string, string>; errors: ImportIssue[] } | { error: ImportIssue }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    return { error: { row: null, column: null, code: 'bad_file' } };
  }
  const sheet = wb.getWorksheet(PRODUCTS_SHEET) ?? wb.worksheets[0];
  if (!sheet) return { error: { row: null, column: null, code: 'bad_file' } };

  const byHeader = new Map(columns.map((c) => [c.header, c]));
  const at = new Map<number, Column>();
  const header = new Map<string, string>();
  sheet.getRow(1).eachCell((cell, col) => {
    const column = byHeader.get(headerKey(cellText(cell.value) ?? ''));
    if (column) {
      at.set(col, column);
      header.set(column.key, column.header);
    }
  });
  for (const key of ['modelName', 'sku'])
    if (!header.has(key))
      return {
        error: {
          row: null,
          column: columns.find((c) => c.key === key)!.header,
          code: 'missing_column',
        },
      };

  const rows: SheetRow[] = [];
  const errors: ImportIssue[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const cells = new Map<string, unknown>();
    sheet.getRow(n).eachCell((cell, col) => {
      const column = at.get(col);
      if (!column) return;
      const parsed = parseCell(column, cellValue(cell.value));
      if (!parsed) return;
      if (parsed.ok) cells.set(column.key, parsed.value);
      else errors.push({ row: n, column: column.header, code: parsed.code, value: parsed.value });
    });
    if (cells.size === 0) continue;
    const model = (cells.get('modelName') as string | undefined)?.toUpperCase().replace(/\s+/g, ' ');
    if (model === EXAMPLE_MODEL) continue;
    if (model) cells.set('modelName', model);
    rows.push({ row: n, cells });
  }
  return { rows, header, errors };
}

/** Rows of each model; product columns must agree across them; SKUs must be unique. */
function groupByModel(rows: SheetRow[], header: Map<string, string>, productKeys: Set<string>, errors: ImportIssue[]) {
  const groups = new Map<string, SheetRow[]>();
  const seenSku = new Map<string, number>();
  for (const r of rows) {
    const model = r.cells.get('modelName') as string | undefined;
    const sku = (r.cells.get('sku') as string | undefined)?.toUpperCase();
    if (!model) errors.push({ row: r.row, column: header.get('modelName')!, code: 'required' });
    if (!sku) errors.push({ row: r.row, column: header.get('sku')!, code: 'required' });
    if (!model || !sku) continue;
    r.cells.set('sku', sku);
    if (seenSku.has(sku)) errors.push({ row: r.row, column: header.get('sku')!, code: 'duplicate_sku', value: sku });
    seenSku.set(sku, r.row);
    groups.set(model, [...(groups.get(model) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const first = new Map<string, string>();
    for (const r of rows) {
      for (const [key, value] of r.cells) {
        if (!productKeys.has(key)) continue;
        const text = JSON.stringify(value);
        if (!first.has(key)) first.set(key, text);
        else if (first.get(key) !== text)
          errors.push({ row: r.row, column: header.get(key) ?? key, code: 'mixed_values' });
      }
    }
  }
  return groups;
}

/** The product as the file wants it: the current product (if any) with every filled cell applied. */
async function buildInput(
  tx: Prisma.TransactionClient,
  model: string,
  rows: SheetRow[],
  current: AdminProduct | null,
  lookups: ExcelLookups,
): Promise<{ input: AdminProductInput; rowOfVariant: (number | null)[] }> {
  const pick = (key: string) => rows.map((r) => r.cells.get(key)).find((v) => v !== undefined);
  const categoryLabel = pick('category') as string | undefined;
  const category = categoryLabel ? lookups.categories.get(categoryLabel)! : undefined;
  const base: AdminProductInput = current
    ? formOf(current)
    : {
        slug: await freeSlug(tx, slugFor(model, category!.slug)),
        modelName: model,
        nameHe: '',
        descriptionHe: '',
        categoryId: category!.id,
        roomIds: [...lookups.rooms.values()],
        attributes: {},
        countryOfOrigin: null,
        warrantyMonths: null,
        careHe: null,
        requiresAssembly: false,
        active: false,
        sortOrder: 0,
        variants: [],
      };

  const input: AdminProductInput = { ...base, attributes: { ...base.attributes }, variants: [...base.variants] };
  const set = <K extends keyof AdminProductInput>(field: K, key: string) => {
    const v = pick(key);
    if (v !== undefined) input[field] = v as AdminProductInput[K];
  };
  set('nameHe', 'nameHe');
  set('countryOfOrigin', 'countryOfOrigin');
  set('warrantyMonths', 'warrantyMonths');
  set('requiresAssembly', 'requiresAssembly');
  set('careHe', 'careHe');
  if (category) input.categoryId = category.id;
  const rooms = pick('rooms') as string[] | undefined;
  if (rooms) input.roomIds = rooms.map((r) => lookups.rooms.get(r)!);
  for (const a of lookups.attributes.filter((x) => x.scope === 'product')) {
    const labels = pick(`attr:${a.code}`) as string[] | undefined;
    if (labels) input.attributes[a.code] = labels.map((l) => a.values.get(l)!);
  }

  // Variants: matched by SKU; new SKUs are added after the existing ones.
  const rowOfVariant: (number | null)[] = input.variants.map(() => null);
  for (const r of rows) {
    const sku = r.cells.get('sku') as string;
    let index = input.variants.findIndex((v) => v.sku === sku);
    if (index === -1) {
      input.variants.push(newVariant(sku));
      rowOfVariant.push(r.row);
      index = input.variants.length - 1;
    } else rowOfVariant[index] = r.row;
    const v: AdminVariant = { ...input.variants[index], options: { ...input.variants[index].options } };
    for (const [key, value] of r.cells) {
      if (key === 'compareAtPrice') v.compareAtPrice = value === 0 ? null : (value as number);
      else if (key === 'fulfillment') v.fulfillment = fulfillmentOf(value as string);
      else if (key.startsWith('attr:')) {
        const a = lookups.attributes.find((x) => `attr:${x.code}` === key)!;
        if (a.scope === 'variant') v.options[a.code] = a.values.get(value as string)!;
      } else if (VARIANT_KEYS.has(key)) (v as unknown as Record<string, unknown>)[key] = value;
    }
    input.variants[index] = v;
  }
  return { input, rowOfVariant };
}

const VARIANT_KEYS = new Set([
  'price',
  'stock',
  'leadTimeDays',
  'productionDays',
  'expectedAt',
  'active',
  ...DIMENSIONS,
]);

function newVariant(sku: string): AdminVariant {
  return {
    sku,
    price: 0,
    compareAtPrice: null,
    stock: 0,
    fulfillment: 'in_stock',
    leadTimeDays: 14,
    productionDays: null,
    expectedAt: null,
    active: true,
    widthCm: 0,
    depthCm: 0,
    heightCm: 0,
    weightKg: null,
    seatHeightCm: null,
    seatDepthCm: null,
    chaiseWidthCm: null,
    chaiseDepthCm: null,
    options: {},
  };
}

/** The product as the form would send it, starting from the saved version. */
function formOf(p: AdminProduct): AdminProductInput {
  const { id: _id, createdAt: _c, updatedAt, ...rest } = p;
  return { ...rest, expectedUpdatedAt: updatedAt };
}

function sameProduct(a: AdminProductInput, b: AdminProductInput): boolean {
  const strip = ({ expectedUpdatedAt: _e, ...rest }: AdminProductInput) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

async function freeSlug(tx: Prisma.TransactionClient, slug: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? slug : `${slug}-${n}`;
    if (!(await tx.product.findUnique({ where: { slug: candidate } }))) return candidate;
  }
}

/** A refusal from the product checks, pointed at the row and column it came from. */
function rejected(
  e: CatalogError,
  rows: SheetRow[],
  rowOfVariant: (number | null)[],
  header: Map<string, string>,
): ImportIssue {
  const body = e.getResponse() as { code: ImportIssue['catalogCode']; field?: string; value?: string };
  const field = body.field ?? '';
  const variant = /^variants\.(\d+)\.(\w+)$/.exec(field);
  const skuRow = body.value ? rows.find((r) => r.cells.get('sku') === body.value)?.row : undefined;
  const key = variant ? variant[2] : field === 'categoryId' ? 'category' : field;
  return {
    row: (variant && rowOfVariant[Number(variant[1])]) ?? skuRow ?? rows[0].row,
    column: header.get(key) ?? null,
    code: 'rejected',
    catalogCode: body.code,
    value: body.value,
  };
}

/** Excel cells can hold rich text, formulas, hyperlinks or dates; reduce them to a plain value. */
function cellValue(value: ExcelJS.CellValue): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
  }
  return null;
}

function cellText(value: ExcelJS.CellValue): string | null {
  const v = cellValue(value);
  return v === null ? null : String(v);
}
