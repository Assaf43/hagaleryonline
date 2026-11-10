import { Prisma } from '../generated/prisma/client.js';

/**
 * Row locks of the order flow. To stay free of deadlocks every transaction takes them in this order:
 * cart → orders → variants (variants always by ascending id).
 *  - checkout: its cart, then its cart's earlier pending orders (superseded), then the cart's variants;
 *  - retry payment: the order, then its variants;
 *  - webhook: the payment, then its order, then (on success) the variants' stock.
 */

/** Serializes checkouts of one cart. NO KEY UPDATE leaves cart line inserts and deletes (FK KEY SHARE) unblocked. */
export async function lockCart(tx: Prisma.TransactionClient, cartId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/** Locks an order row. */
export async function lockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Locks variant rows in ascending id order. Every reservation and stock change of these variants waits here, so
 * `availableStock` read afterwards in the same transaction stays true until commit (spec §5.2).
 */
export async function lockVariants(tx: Prisma.TransactionClient, variantIds: number[]): Promise<void> {
  const ids = [...new Set(variantIds)].sort((a, b) => a - b);
  if (ids.length === 0) return;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM variants WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`);
}
