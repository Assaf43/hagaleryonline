import type { ConfigService } from '@nestjs/config';
import { BRAND, INVOICE_TYPE_LABELS_HE, type InvoiceType } from '@hg/models';
import { esc } from '../notifications/templates/layout.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { InvoiceIssueInput, InvoiceIssueResult, InvoiceLine, InvoiceProvider } from './invoice-provider.js';
import { INVOICE_TYPE_DB } from './invoice-view.js';
import { israelDate } from './vat.js';

export const MOCK_INVOICE_CODE = 'mock';

const SERIES: Record<InvoiceType, { sequence: string; prefix: string }> = {
  tax_invoice_receipt: { sequence: 'mock_invoice_seq', prefix: 'MOCK-INV-' },
  credit_note: { sequence: 'mock_credit_note_seq', prefix: 'MOCK-CN-' },
};

/**
 * `mock` adapter (development and tests, spec §5.4): running numbers `MOCK-INV-000001` / `MOCK-CN-000001` from a
 * Postgres sequence per type, and a simple self-contained Hebrew HTML document. Like a real provider it remembers each
 * idempotency key (`mock_invoice_documents`), so the same key always returns the same number (and, with the same
 * input, the same file). Refuses
 * to load in production: it issues no real tax document.
 */
export class MockInvoiceProvider implements InvoiceProvider {
  readonly code = MOCK_INVOICE_CODE;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    if (config.get<string>('NODE_ENV') === 'production')
      throw new Error('INVOICE_PROVIDER = mock cannot run in production: choose a real invoicing provider.');
  }

  /** The document is dated `input.issuedAt` (the event's moment), so a retry renders the same file. */
  async issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult> {
    const number = await this.number(input.idempotencyKey, input.type, input.issuedAt);
    const html = renderMockDocument({ ...input, number });
    return { number, documentUrl: null, file: Buffer.from(html, 'utf8') };
  }

  /** The number of this key: the stored one, or a new number from the type's sequence. */
  private async number(key: string, type: InvoiceType, issuedAt: Date): Promise<string> {
    const known = await this.known(key, type);
    if (known) return known;
    const { sequence, prefix } = SERIES[type];
    const [{ n }] = await this.prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval(${sequence}::regclass) AS n`;
    // A concurrent call with the same key may insert first: then its number is the one (ours is a gap).
    await this.prisma.mockInvoiceDocument.createMany({
      data: [
        {
          idempotencyKey: key,
          type: INVOICE_TYPE_DB[type],
          number: `${prefix}${String(n).padStart(6, '0')}`,
          issuedAt,
        },
      ],
      skipDuplicates: true,
    });
    const stored = await this.known(key, type);
    if (!stored) throw new Error(`Mock invoice for ${key} was not stored`);
    return stored;
  }

  private async known(key: string, type: InvoiceType): Promise<string | null> {
    const row = await this.prisma.mockInvoiceDocument.findUnique({ where: { idempotencyKey: key } });
    if (!row) return null;
    if (row.type !== INVOICE_TYPE_DB[type]) throw new Error(`Idempotency key ${key} was used for another type`);
    return row.number;
  }
}

export interface MockDocumentData extends Omit<InvoiceIssueInput, 'idempotencyKey'> {
  number: string;
}

const AMOUNT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Agorot → "1,180.00 ₪" (a tax document shows agorot), left-to-right inside the Hebrew text. */
const money = (agorot: number): string =>
  `<bdi dir="ltr">${agorot < 0 ? '-' : ''}${AMOUNT.format(Math.abs(agorot) / 100)} ₪</bdi>`;

/** "13.11.2026": the Israel calendar date. */
function israelDay(at: Date): string {
  const [y, m, d] = israelDate(at).split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
}

const lineRow = (l: InvoiceLine): string =>
  `<tr><td>${esc(l.description)}</td><td class="n"><bdi>${esc(l.quantity)}</bdi></td><td class="n">${money(l.unitPrice)}</td><td class="n">${money(l.lineTotal)}</td></tr>`;

/** The mock's document: one self-contained Hebrew RTL HTML page (no external files), every value escaped. */
export function renderMockDocument(d: MockDocumentData): string {
  const title = INVOICE_TYPE_LABELS_HE[d.type];
  const percent = `${Number((d.vatRate * 100).toFixed(2))}%`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} ${esc(d.number)}</title>
<style>
body{font-family:Assistant,Arial,Helvetica,sans-serif;color:#1a1a1a;margin:0;padding:24px;background:#ffffff;}
main{max-width:760px;margin:0 auto;}
h1{font-size:24px;margin:0 0 4px;}
.mock{color:#8a1c1c;font-weight:700;margin:0 0 16px;}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:16px 0;}
dt{color:#555555;}
dd{margin:0;}
table{width:100%;border-collapse:collapse;margin:16px 0;}
th,td{border-block-end:1px solid #dddddd;padding:8px;text-align:start;}
.n{text-align:end;white-space:nowrap;}
.sum td{border:none;}
.total td{font-weight:700;font-size:18px;}
</style>
</head>
<body>
<main>
<h1>${esc(title)} <bdi>${esc(d.number)}</bdi></h1>
<p class="mock">מסמך לדוגמה (mock) — אינו מסמך מס</p>
<dl>
<dt>מוכר</dt><dd><bdi dir="ltr">${esc(BRAND.name)}</bdi></dd>
<dt>לקוח</dt><dd>${esc(d.customer.fullName)}</dd>
<dt>הזמנה</dt><dd><bdi>${esc(d.orderNumber)}</bdi></dd>
<dt>תאריך</dt><dd><bdi>${israelDay(d.issuedAt)}</bdi></dd>
</dl>
<table>
<thead><tr><th>תיאור</th><th class="n">כמות</th><th class="n">מחיר ליחידה</th><th class="n">סה״כ</th></tr></thead>
<tbody>
${d.lines.map(lineRow).join('\n')}
</tbody>
</table>
<table>
<tbody>
<tr class="sum"><td>סכום לפני מע״מ</td><td class="n">${money(d.amount - d.vatAmount)}</td></tr>
<tr class="sum"><td>מע״מ <bdi>${percent}</bdi></td><td class="n">${money(d.vatAmount)}</td></tr>
<tr class="sum total"><td>${d.type === 'credit_note' ? 'סכום הזיכוי' : 'סה״כ לתשלום'}</td><td class="n">${money(d.amount)}</td></tr>
</tbody>
</table>
</main>
</body>
</html>
`;
}
