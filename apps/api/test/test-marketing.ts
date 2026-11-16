import type { Prisma } from './../src/generated/prisma/client.js';
import type { PrismaService } from './../src/prisma/prisma.service.js';

/**
 * Deletes marketing contacts for test cleanup. Their consent history RESTRICTs deleting a contact (it is the legal
 * record), so the events go first — something only test data may do.
 */
export async function deleteMarketingContacts(
  prisma: PrismaService,
  where: Prisma.MarketingContactWhereInput,
): Promise<void> {
  await prisma.marketingConsentEvent.deleteMany({ where: { contact: where } });
  await prisma.marketingContact.deleteMany({ where });
}
