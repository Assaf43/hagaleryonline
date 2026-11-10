import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Most units of a made-to-order or pre-order variant in one cart line (CRT-02). */
export const MAX_MADE_TO_ORDER = 10;

/**
 * Units of each variant that can still be sold, by variant id (missing ids are left out).
 * For now this is the stock column; Phase 4c subtracts active reservations (§5.2, decision 69).
 */
export async function availableStock(
  db: Prisma.TransactionClient | PrismaService,
  variantIds: number[],
): Promise<Map<number, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db.variant.findMany({
    where: { id: { in: [...new Set(variantIds)] } },
    select: { id: true, stock: true },
  });
  return new Map(rows.map((r) => [r.id, Math.max(0, r.stock)]));
}
