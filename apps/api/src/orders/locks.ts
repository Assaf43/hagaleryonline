import { Prisma } from '../generated/prisma/client.js';

/**
 * Row locks of the order flow. To stay free of deadlocks every transaction takes them in this order:
 * store-cart → welcome → cart → orders → variants (variants always by ascending id) → promotions (by ascending id).
 *  - welcome (Phase 5c; the account's checkout lock since Phase 7c): a transaction-scoped advisory lock per account
 *    (`lockWelcome`), taken FIRST, before any row lock, by every checkout for an account (website or store) and by the
 *    retry of an order of an account. Nothing else takes it, and whoever waits for it holds no lock yet, so it cannot
 *    close a cycle with the row locks below. It makes one account's checkouts and retries run one after the other —
 *    from any of its carts — so only one live order holds a personal code (spec §5.2: the next one sees it held) and a
 *    members-only coupon is taken once;
 *  - account cart (Phase 5c): a transaction-scoped advisory lock per account (`lockAccountCart`), taken first by the
 *    first add of a signed-in customer (so two first adds make one cart) and by the cart merge on sign-in
 *    (CartService.attachToCustomer), which then locks every cart involved by ascending id. Only these take it, and a
 *    waiter holds no row lock yet;
 *  - store cart (Phase 6): a transaction-scoped advisory lock per seller (`lockStoreCart`), taken FIRST by every
 *    transaction that creates or reuses the seller's open cart (StoreCartService.start / openOrStartInTx and the
 *    store customer confirmation), so a seller never ends up with two open carts, by the store checkout
 *    (CheckoutService.placeOrder with `channel: 'store'`: then the welcome lock and the cart row, so it never waits
 *    for a row a customer endpoint holds while that endpoint waits for this lock, and a new sale cannot delete the
 *    cart mid-checkout), by the retry of a store order, and by the seller's line and coupon changes
 *    (StoreCartService.changeOpen: held while the website cart code changes the cart on other connections — that code
 *    takes no store-cart lock). A waiter holds no row lock yet;
 *  - checkout: its cart, then its cart's earlier pending orders (superseded), then the cart's variants, then the
 *    limited promotions it may use and the template of an entered personal code (PromotionsService.lockLimited), so
 *    their usage counts — and the code's use and holders, and the account's paid orders — are read only after it and
 *    hold until commit. A store checkout
 *    then saves the delivery address under the customer row (FOR NO KEY UPDATE, last; the account's address writes
 *    take only that row);
 *  - retry payment: its cart, the order, its variants, then the order's promotion (PromotionsService.lockOne); the
 *    seller's reopen of a waiting store order also locks the order's payments right before the order (the cancel's
 *    payments → order), so the old page's webhook either lands first or finds its payment cancelled;
 *  - webhook: the payment, then its order, then (on success) the variants' stock, then the order's promotion
 *    (its usage count +1), then the personal code it holds (marked used; a row no other transaction locks
 *    explicitly). It never updates the cart row inside its transaction (that would be order → cart);
 *    the cart's coupon is cleared after commit;
 *  - customer cancel: the order's payments (ascending id), then the order (the webhook's payment → order);
 *  - admin status move: the order alone;
 *  - marketing (Phase 7): a transaction-scoped advisory lock per e-mail (MarketingService), always the LAST lock of
 *    its transaction — checkout and store checkout take it after the order insert, sign-up after the customer insert,
 *    the e-mail change after the customer update. While holding it only marketing rows and outbox jobs are written.
 */

/** Serializes checkouts of one cart. NO KEY UPDATE leaves cart line inserts and deletes (FK KEY SHARE) unblocked. */
export async function lockCart(tx: Prisma.TransactionClient, cartId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/** One account's checkout lock (see "welcome" above); released at commit or rollback. */
export async function lockWelcome(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'welcome:' + customerId}::text))`;
}

/** One account's cart lock (see above); released at commit or rollback. */
export async function lockAccountCart(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'cart:' + customerId}::text))`;
}

/** One seller's open-store-cart lock (see above); released at commit or rollback. */
export async function lockStoreCart(tx: Prisma.TransactionClient, sellerId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'store-cart:' + String(sellerId)}::text))`;
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
