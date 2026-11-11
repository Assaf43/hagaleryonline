import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Most units of a made-to-order or pre-order variant in one cart line (CRT-02). */
export const MAX_MADE_TO_ORDER = 10;

/**
 * Units of each variant that can still be sold, by variant id (missing ids are left out): the stock column minus
 * the units held by orders waiting for payment whose reservation has not passed (spec §5.2, decision 69). An
 * expired reservation simply stops counting; there is no background job. One SQL query per call.
 *
 * Inside a transaction that locked the variant rows (`SELECT … FOR UPDATE`), the result stays true until commit:
 * every other reservation of these variants is made under the same locks.
 *
 * `ownCartId`: the reservations of that cart's own pending orders are left out. A customer back from the payment
 * page must still see their lines as available — the next checkout of the cart expires those orders first — or the
 * total on screen would leave them out and never match the charged one (`price_changed`).
 */
export async function availableStock(
  db: Prisma.TransactionClient | PrismaService,
  variantIds: number[],
  ownCartId?: string,
): Promise<Map<number, number>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const notOwn = ownCartId ? Prisma.sql`AND o.cart_id IS DISTINCT FROM ${ownCartId}::uuid` : Prisma.empty;
  const rows = await db.$queryRaw<{ id: number; available: number }[]>(Prisma.sql`
    SELECT v.id,
           (v.stock - COALESCE((
             SELECT SUM(oi.quantity)
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE oi.variant_id = v.id
               AND o.status = 'pending_payment'
               AND o.reserved_until > now()
               ${notOwn}
           ), 0))::int AS available
    FROM variants v
    WHERE v.id = ANY(${ids}::int[])
  `);
  return new Map(rows.map((r) => [r.id, Math.max(0, r.available)]));
}
