import type { CustomerAddressView } from '@hg/models';
import type { CustomerAddress, Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = Prisma.TransactionClient | PrismaService;
type AddressRow = CustomerAddress & { locality: { nameHe: string } };

/** The account's saved addresses: the default first, then newest first. Also the checkout prefill (spec §6.4). */
export async function listAddresses(db: Db, customerId: string): Promise<CustomerAddressView[]> {
  const rows = await db.customerAddress.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    include: { locality: { select: { nameHe: true } } },
  });
  return rows.map(toView);
}

export function toView(row: AddressRow): CustomerAddressView {
  return {
    id: row.id,
    localityId: row.localityId,
    localityNameHe: row.locality.nameHe,
    street: row.street,
    houseNumber: row.houseNumber,
    apartment: row.apartment,
    floor: row.floor,
    hasElevator: row.hasElevator,
    notes: row.notes,
    isDefault: row.isDefault,
  };
}
