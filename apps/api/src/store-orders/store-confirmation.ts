import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** How long the customer's confirmation of a store cart holds (spec §4.2). */
export const STORE_CONFIRMATION_TTL_MS = 2 * 60 * 60_000;

/** Confirmed or used before this moment: the confirmation has lapsed. */
function cutoff(now: Date): Date {
  return new Date(now.getTime() - STORE_CONFIRMATION_TTL_MS);
}

/**
 * The one two-hour rule (spec §4.2): a confirmation is live when it is at most two hours old AND the cart was used
 * within the last two hours. `lapseStoreConfirmation` clears exactly the confirmations this calls not live.
 */
export function isConfirmationLive(
  cart: { storeConfirmedAt: Date | null; updatedAt: Date },
  now = new Date(),
): boolean {
  const before = cutoff(now);
  return cart.storeConfirmedAt !== null && cart.storeConfirmedAt >= before && cart.updatedAt >= before;
}

/**
 * A store cart's attached customer lapses two hours after the confirmation, or when the cart was idle for two hours:
 * the seller must attach and confirm again. The cart's lines stay. Called before the cart is marked as used.
 */
export async function lapseStoreConfirmation(
  db: Prisma.TransactionClient | PrismaService,
  cartId: string,
  now = new Date(),
): Promise<void> {
  const before = cutoff(now);
  await db.cart.updateMany({
    where: {
      id: cartId,
      sellerId: { not: null },
      storeCustomerId: { not: null },
      OR: [{ storeConfirmedAt: { lt: before } }, { updatedAt: { lt: before } }],
    },
    data: { storeCustomerId: null, storeConfirmedAt: null },
  });
}
