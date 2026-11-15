import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** How long the customer's confirmation of a store cart holds (spec §4.2). */
export const STORE_CONFIRMATION_TTL_MS = 2 * 60 * 60_000;

/**
 * A store cart's attached customer lapses two hours after the confirmation, or when the cart was idle for two hours:
 * the seller must attach and confirm again. The cart's lines stay. Called before the cart is marked as used.
 */
export async function lapseStoreConfirmation(
  db: Prisma.TransactionClient | PrismaService,
  cartId: string,
  now = new Date(),
): Promise<void> {
  const before = new Date(now.getTime() - STORE_CONFIRMATION_TTL_MS);
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
