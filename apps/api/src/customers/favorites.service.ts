import { Injectable } from '@nestjs/common';
import { FAVORITES_MAX, FAVORITES_PUT_MAX } from '@hg/models';
import { MarketingService } from '../marketing/marketing.service.js';
import { lockFavorites } from '../orders/locks.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { badField } from './account-errors.js';

/** A positive integer product id. */
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647;

/**
 * Favorites on the account (CLB-09, spec §5.5): product ids, newest first. A change takes the account's favorites lock,
 * and when it changed anything it tells the marketing contact (interests changed) as the last step of the same
 * transaction.
 */
@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketing: MarketingService,
  ) {}

  async list(customerId: string): Promise<number[]> {
    return this.read(this.prisma, customerId);
  }

  /**
   * `PUT { productIds }`: the union of the saved list and the sent ids (the sent ones that are new go first, in the
   * order sent), capped at `FAVORITES_MAX` by dropping the oldest. Ids of unknown products are dropped silently.
   * Returns the list.
   */
  async merge(customerId: string, body: unknown): Promise<number[]> {
    const raw = (body as { productIds?: unknown } | null)?.productIds;
    if (!Array.isArray(raw) || raw.length > FAVORITES_PUT_MAX || !raw.every(isId)) throw badField('productIds');
    const sent = [...new Set(raw as number[])];
    return this.prisma.$transaction(async (tx) => {
      await lockFavorites(tx, customerId);
      const before = await this.read(tx, customerId);
      const have = new Set(before);
      const known = new Set(
        (await tx.product.findMany({ where: { id: { in: sent } }, select: { id: true } })).map((p) => p.id),
      );
      const fresh = sent.filter((id) => known.has(id) && !have.has(id));
      if (fresh.length > 0) {
        // One millisecond apart keeps the sent order; the base is later than every saved one, so the new ones lead.
        const newest = await tx.customerFavorite.findFirst({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const now = Math.max(Date.now(), (newest?.createdAt.getTime() ?? 0) + fresh.length);
        await tx.customerFavorite.createMany({
          data: fresh.map((productId, i) => ({
            customerId,
            productId,
            createdAt: new Date(now - i),
          })),
        });
      }
      const after = await this.read(tx, customerId);
      const dropped = after.slice(FAVORITES_MAX);
      if (dropped.length > 0) {
        await tx.customerFavorite.deleteMany({ where: { customerId, productId: { in: dropped } } });
      }
      const kept = after.slice(0, FAVORITES_MAX);
      const changed = fresh.length > 0 || dropped.length > 0;
      if (changed) await this.marketing.favoritesChanged(tx, customerId);
      return kept;
    });
  }

  /** `DELETE :productId`: removes it; an id that is not in the list is fine (nothing changes). */
  async remove(customerId: string, productId: string): Promise<void> {
    if (!/^[1-9]\d{0,9}$/.test(productId) || Number(productId) > 2147483647) throw badField('productId');
    await this.prisma.$transaction(async (tx) => {
      await lockFavorites(tx, customerId);
      const { count } = await tx.customerFavorite.deleteMany({ where: { customerId, productId: Number(productId) } });
      if (count > 0) await this.marketing.favoritesChanged(tx, customerId);
    });
  }

  private async read(db: Pick<PrismaService, 'customerFavorite'>, customerId: string): Promise<number[]> {
    const rows = await db.customerFavorite.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { productId: 'desc' }],
      select: { productId: true },
    });
    return rows.map((r) => r.productId);
  }
}
