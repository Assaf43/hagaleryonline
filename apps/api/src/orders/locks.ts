import { Prisma } from '../generated/prisma/client.js';

/**
 * Row locks of the order flow. To stay free of deadlocks every transaction takes them in this order:
 * welcome → cart → orders → variants (variants always by ascending id) → promotions (by ascending id).
 *  - welcome (Phase 5c): a transaction-scoped advisory lock per account (`lockWelcome`), taken FIRST, before any
 *    row lock, by a checkout with a customer session and by the retry of an order that holds the welcome benefit.
 *    Nothing else takes it, and whoever waits for it holds no lock yet, so it cannot close a cycle with the row
 *    locks below. It makes one account's checkouts run one after the other, so only one live order holds the
 *    benefit (decision 79);
 *  - cart merge on sign-in (CartService.attachToCustomer): the account's cart and the guest cart, by ascending id;
 *  - checkout: its cart, then its cart's earlier pending orders (superseded), then the cart's variants, then the
 *    limited promotions it may use (PromotionsService.lockLimited), so their usage counts hold until commit;
 *  - retry payment: its cart, the order, its variants, then the order's promotion (PromotionsService.lockOne);
 *  - webhook: the payment, then its order, then (on success) the variants' stock, then the order's promotion
 *    (its usage count +1). It never updates the cart row inside its transaction (that would be order → cart);
 *    the cart's coupon is cleared after commit;
 *  - customer cancel: the order's payments (ascending id), then the order (the webhook's payment → order);
 *  - admin status move: the order alone.
 */

/** Serializes checkouts of one cart. NO KEY UPDATE leaves cart line inserts and deletes (FK KEY SHARE) unblocked. */
export async function lockCart(tx: Prisma.TransactionClient, cartId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/** One account's welcome-benefit lock (see above); released at commit or rollback. */
export async function lockWelcome(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'welcome:' + customerId}::text))`;
}

/** Locks the payment rows of an order (ascending id); taken before `lockOrder` where a payment is also updated. */
export async function lockOrderPayments(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payments WHERE order_id = ${orderId}::uuid ORDER BY id FOR UPDATE`;
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
