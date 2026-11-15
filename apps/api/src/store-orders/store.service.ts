import { HttpStatus, Injectable, BadRequestException, HttpException } from '@nestjs/common';
import type { StoreInfo } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface StoreInput {
  nameHe: string;
  address: string;
  hoursHe: string;
  phone: string;
}

const invalid = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });

/** Trims and checks a store edit: `nameHe` 1–80 characters, the others up to 200. */
export function parseStoreInput(body: unknown): StoreInput {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const text = (field: keyof StoreInput, min: number, max: number): string => {
    const value = input[field];
    if (typeof value !== 'string') throw invalid(field);
    const trimmed = value.trim();
    if (trimmed.length < min || trimmed.length > max) throw invalid(field);
    return trimmed;
  };
  return {
    nameHe: text('nameHe', 1, 80),
    address: text('address', 0, 200),
    hoursHe: text('hoursHe', 0, 200),
    phone: text('phone', 0, 200),
  };
}

const toInfo = (s: { id: number; nameHe: string; address: string; hoursHe: string; phone: string }): StoreInfo => ({
  id: s.id,
  nameHe: s.nameHe,
  address: s.address,
  hoursHe: s.hoursHe,
  phone: s.phone,
});

/** The physical store (Phase 6, spec §4.4): one active row, edited by the Super Admin. */
@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The single active store; 503 `store_not_configured` when there is none. */
  async activeStore(): Promise<{ id: number }> {
    const store = await this.prisma.store.findFirst({
      where: { active: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!store)
      throw new HttpException(
        { statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: 'store_not_configured' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    return store;
  }

  async get(): Promise<StoreInfo> {
    const { id } = await this.activeStore();
    return toInfo(await this.prisma.store.findUniqueOrThrow({ where: { id } }));
  }

  async update(input: StoreInput, actor: { actorId: number; ip?: string | null }): Promise<StoreInfo> {
    const { id } = await this.activeStore();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.store.findUniqueOrThrow({ where: { id } });
      const row = await tx.store.update({ where: { id }, data: input });
      await this.audit.record(
        {
          ...actor,
          action: 'store.update',
          entityType: 'store',
          entityId: id,
          before: toInfo(before),
          after: toInfo(row),
        },
        tx,
      );
      return toInfo(row);
    });
  }
}
