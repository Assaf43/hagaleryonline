import type { Prisma } from './../src/generated/prisma/client.js';
import type { PrismaService } from './../src/prisma/prisma.service.js';

/** The test orders of the e2e files: the contact name starts with ZZ. */
export const TEST_ORDERS: Prisma.OrderWhereInput = { contact: { path: ['fullName'], string_starts_with: 'ZZ' } };

/**
 * Deletes orders for test cleanup. Tax documents RESTRICT deleting their order and refund (migration
 * invoices_restrict), so the orders' invoices go first — something only test data may do.
 */
export async function deleteOrders(prisma: PrismaService, where: Prisma.OrderWhereInput = {}): Promise<void> {
  await prisma.invoice.deleteMany({ where: { order: where } });
  await prisma.order.deleteMany({ where });
}
