import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AdminVatRate, AdminVatRateInput } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { israelDate } from './vat.js';

const invalid = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });
const exists = () => new ConflictException({ statusCode: 409, code: 'vat_rate_exists' });
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRealDate = (value: string): boolean => {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
};

/** `0 < rate < 1`, at most 4 decimals (the column is DECIMAL(5,4)). */
export function parseVatInput(body: unknown): AdminVatRateInput {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const { rate, effectiveFrom } = b;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate >= 1) throw invalid('rate');
  if (Math.abs(rate * 10_000 - Math.round(rate * 10_000)) > 1e-9) throw invalid('rate');
  if (typeof effectiveFrom !== 'string' || !isRealDate(effectiveFrom)) throw invalid('effectiveFrom');
  return { rate: Math.round(rate * 10_000) / 10_000, effectiveFrom };
}

const view = (r: { id: number; rate: Prisma.Decimal; effectiveFrom: Date }): AdminVatRate => ({
  id: r.id,
  rate: Number(r.rate),
  effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
});

/** The VAT rate table (spec §3): rates are only added, and only for a future date; history stays as issued. */
@Injectable()
export class VatAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<AdminVatRate[]> {
    const rows = await this.prisma.vatRate.findMany({ orderBy: { effectiveFrom: 'asc' } });
    return rows.map(view);
  }

  async add(input: AdminVatRateInput, meta: { actorId: number; ip?: string | null }): Promise<AdminVatRate> {
    const date = new Date(`${input.effectiveFrom}T00:00:00.000Z`);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (await tx.vatRate.findUnique({ where: { effectiveFrom: date } })) throw exists();
        if (input.effectiveFrom <= israelDate(new Date())) throw invalid('effectiveFrom');
        const latest = await tx.vatRate.findFirst({ orderBy: { effectiveFrom: 'desc' } });
        if (latest && date <= latest.effectiveFrom) throw invalid('effectiveFrom');
        const row = view(await tx.vatRate.create({ data: { rate: input.rate, effectiveFrom: date } }));
        await this.audit.record(
          {
            ...meta,
            action: 'vat.add',
            entityType: 'vat_rate',
            entityId: row.id,
            after: { rate: row.rate, effectiveFrom: row.effectiveFrom },
          },
          tx,
        );
        return row;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw exists();
      throw e;
    }
  }
}
