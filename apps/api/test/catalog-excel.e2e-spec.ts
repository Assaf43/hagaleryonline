import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Response } from 'superagent';
import type { AuditPage, ImportReport } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { ORIGIN, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/** Excel template, export and import end to end (Phase 2c, ADM-09). Cleans up after itself. */
describe('Catalog Excel (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let exported: Buffer;
  let albaPrice: number;
  const ALBA_SKU = 'ALBA-260-BG-WV-R';

  const binary = (res: Response, done: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };
  const download = async (b: AdminBrowser, what: 'template' | 'export') =>
    (await b.agent.get(`/api/admin/catalog/excel/${what}`).buffer(true).parse(binary).expect(200)).body as Buffer;
  const upload = async (b: AdminBrowser, file: Buffer, step: 'check' | 'import') =>
    (
      await b.agent
        .post(`/api/admin/catalog/excel/${step}`)
        .set('Origin', ORIGIN)
        .attach('file', file, 'catalog.xlsx')
        .expect(200)
    ).body as ImportReport;

  /** Opens a workbook, lets the test edit the products sheet by header name, and saves it. */
  async function edit(file: Buffer, change: (sheet: Sheet) => void): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('מוצרים')!;
    const headers = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) => headers.set(cell.text.replace(' *', ''), col));
    const col = (header: string) => headers.get(header)!;
    change({
      ws,
      rowOf: (sku) => {
        for (let n = 2; n <= ws.rowCount; n++) if (ws.getRow(n).getCell(col('מק"ט')).value === sku) return n;
        throw new Error(`no row for ${sku}`);
      },
      set: (row, header, value) => (ws.getRow(row).getCell(col(header)).value = value),
      add: (cells) => {
        const row = ws.getRow(ws.rowCount + 1);
        for (const [header, value] of Object.entries(cells)) row.getCell(col(header)).value = value;
        return row.number;
      },
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  interface Sheet {
    ws: ExcelJS.Worksheet;
    rowOf(sku: string): number;
    set(row: number, header: string, value: ExcelJS.CellValue): void;
    add(cells: Record<string, ExcelJS.CellValue>): number;
  }
  const newModel = (sku: string, color: string) => ({
    'שם דגם': 'ZZNEW',
    'שם המוצר': 'ספה חדשה מאקסל',
    קטגוריה: 'ספות › ספות תלת-מושביות',
    סגנון: 'מודרני',
    'מק"ט': sku,
    'מחיר (₪)': 4290,
    מלאי: 1,
    צבע: color,
    'רוחב (ס"מ)': 230,
    'עומק (ס"מ)': 95,
    'גובה (ס"מ)': 84,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    albaPrice = (await prisma.variant.findUnique({ where: { sku: ALBA_SKU } }))!.price;
  });

  afterAll(async () => {
    await prisma.variant.update({ where: { sku: ALBA_SKU }, data: { price: albaPrice } });
    await resetAdminData(prisma);
    await app.close();
  });

  it('gives a Hebrew template with drop-downs, instructions and an example row that is not imported', async () => {
    const file = await download(editor, 'template');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => [w.name, w.state])).toEqual([
      ['מוצרים', 'visible'],
      ['רשימות', 'hidden'],
      ['הוראות', 'visible'],
    ]);
    const ws = wb.getWorksheet('מוצרים')!;
    const headers = (ws.getRow(1).values as string[]).filter(Boolean);
    expect(headers.slice(0, 4)).toEqual(['שם דגם *', 'שם המוצר', 'קטגוריה', 'חדרים']);
    expect(headers).toEqual(expect.arrayContaining(['מק"ט *', 'מחיר (₪)', 'צבע', 'סוג בד', 'רוחב (ס"מ)']));
    expect(ws.getRow(2).getCell(1).value).toBe('EXAMPLE');
    expect(ws.getCell('C2').dataValidation).toMatchObject({ type: 'list' });

    const report = await upload(editor, file, 'check');
    expect(report.errors).toEqual([{ row: null, column: null, code: 'no_rows' }]);
  });

  it('exports the catalog, and importing it back changes nothing', async () => {
    exported = await download(editor, 'export');
    const report = await upload(editor, exported, 'check');
    expect(report.errors).toEqual([]);
    expect(report.summary).toMatchObject({ productsCreated: 0, productsUpdated: 0, productsUnchanged: 27 });
    expect(report.summary.rows).toBe(await prisma.variant.count());
  });

  it('checks first without saving, then imports: a price update and a new hidden product', async () => {
    const file = await edit(exported, (s) => {
      s.set(s.rowOf(ALBA_SKU), 'מחיר (₪)', '4,190');
      s.add(newModel('ZZNEW-230-BG', 'בז׳'));
      s.add(newModel('ZZNEW-230-GR', 'אפור'));
    });

    const check = await upload(editor, file, 'check');
    expect(check).toMatchObject({
      applied: false,
      errors: [],
      summary: { productsCreated: 1, productsUpdated: 1, productsUnchanged: 26, variantsCreated: 2, priceChanges: 1 },
    });
    expect((await prisma.variant.findUnique({ where: { sku: ALBA_SKU } }))!.price).toBe(albaPrice);
    expect(await prisma.product.findUnique({ where: { modelName: 'ZZNEW' } })).toBeNull();

    const imported = await upload(editor, file, 'import');
    expect(imported).toMatchObject({ applied: true, errors: [] });
    expect((await prisma.variant.findUnique({ where: { sku: ALBA_SKU } }))!.price).toBe(419_000);
    const created = await prisma.product.findUnique({ where: { modelName: 'ZZNEW' }, include: { variants: true } });
    expect(created).toMatchObject({ active: false, slug: 'zznew-three-seater-sofa', nameHe: 'ספה חדשה מאקסל' });
    expect(created!.variants.map((v) => v.sku).sort()).toEqual(['ZZNEW-230-BG', 'ZZNEW-230-GR']);

    const audit = (await owner.get('/audit').expect(200)).body as AuditPage;
    expect(audit.items[0]).toMatchObject({ action: 'catalog.import', after: { productsCreated: 1, priceChanges: 1 } });
    expect(audit.items.some((e) => e.action === 'variant.update' && e.entityLabel === ALBA_SKU)).toBe(true);
  });

  it('reports every problem by row and column, and saves nothing', async () => {
    const before = await prisma.variant.count();
    let rows: Record<string, number> = {};
    const file = await edit(exported, (s) => {
      rows = {
        price: s.add({ ...newModel('ZZBAD-1', 'בז׳'), 'שם דגם': 'ZZBAD', 'מחיר (₪)': 'הרבה' }),
        color: s.add({ ...newModel('ZZBAD-2', 'סגלגל'), 'שם דגם': 'ZZBAD' }),
        mixed: s.add({ ...newModel('ZZBAD-3', 'אפור'), 'שם דגם': 'ZZBAD', קטגוריה: 'כורסאות' }),
        twice: s.add({ ...newModel('ZZBAD-1', 'שחור'), 'שם דגם': 'ZZBAD' }),
      };
      s.set(s.rowOf(ALBA_SKU), 'שם דגם', 'ZZOTHER');
    });
    const report = await upload(editor, file, 'check');
    expect(report.applied).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        { row: rows.price, column: 'מחיר (₪)', code: 'number', value: 'הרבה' },
        { row: rows.color, column: 'צבע', code: 'not_in_list', value: 'סגלגל' },
        { row: rows.mixed, column: 'קטגוריה', code: 'mixed_values' },
        { row: rows.twice, column: 'מק"ט', code: 'duplicate_sku', value: 'ZZBAD-1' },
      ]),
    );
    // Even "import" refuses a file with errors.
    expect((await upload(editor, file, 'import')).applied).toBe(false);
    expect(await prisma.variant.count()).toBe(before);
  });

  it('points at the row when a SKU belongs to another model, or a value fails the product checks', async () => {
    let row = 0;
    // On the empty template, so the SKU appears only once in the file.
    const taken = await edit(await download(editor, 'template'), (s) => {
      row = s.add({ ...newModel('ALBA-260-BG-WV-L', 'בז׳'), 'שם דגם': 'ZZTHIEF' });
    });
    expect((await upload(editor, taken, 'check')).errors).toEqual([
      { row, column: 'מק"ט', code: 'sku_taken', value: 'ALBA-260-BG-WV-L (ALBA)' },
    ]);

    const fakeSale = await edit(exported, (s) => {
      row = s.rowOf(ALBA_SKU);
      s.set(row, 'מחיר לפני הנחה (₪)', 3000);
    });
    expect((await upload(editor, fakeSale, 'check')).errors).toEqual([
      { row, column: 'מחיר לפני הנחה (₪)', code: 'rejected', catalogCode: 'invalid' },
    ]);
  });

  it('refuses a file that is not a workbook', async () => {
    const report = await upload(editor, Buffer.from('not excel'), 'check');
    expect(report.errors).toEqual([{ row: null, column: null, code: 'bad_file' }]);
  });
});
