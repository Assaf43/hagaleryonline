import { OrderStatus, Prisma, type MarketingContact } from '../generated/prisma/client.js';
import { PAID_OR_LATER } from '../orders/order-transitions.js';
import type { SyncedContact } from './marketing-provider.js';

/** The Prisma calls `marketingFields` makes (a client or a transaction). */
export type FieldsDb = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'customer' | 'category' | 'orderItem' | 'customerFavorite' | 'product'
>;

/** The DB values of `PAID_OR_LATER` (each enum value maps to its lower-case name in schema.prisma). */
const PAID_DB_VALUES = [...PAID_OR_LATER].map((s: OrderStatus) => s.toLowerCase());
/** A category chain longer than this is a cycle (the tree has two levels today). */
const MAX_DEPTH = 10;

/**
 * The fields of a contact the e-mail tool keeps (spec §5.4), read now: `member` when the contact is linked to an
 * account (its first name too), else `newsletter`; whether it has a paid order (paid or any later step,
 * `PAID_OR_LATER`) and when the latest was paid; the top-level category slugs of those orders' products. Only orders
 * the linked account placed count: a guest order is never linked to anyone (decision 77), even when its e-mail is the
 * contact's, so a contact without an account has no purchase fields. The linked account's favorites join the interests (CLB-09): the top-level category of each favorite product.
 */
export async function marketingFields(db: FieldsDb, contact: MarketingContact): Promise<SyncedContact> {
  const customerId = contact.customerId;
  const customer = customerId
    ? await db.customer.findUnique({ where: { id: customerId }, select: { fullName: true } })
    : null;
  const orders = customerId
    ? await db.$queryRaw<{ id: string; paid_at: Date | null }[]>`
        SELECT o.id,
               (SELECT min(p.updated_at) FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded') AS paid_at
        FROM orders o
        WHERE o.status::text IN (${Prisma.join(PAID_DB_VALUES)}) AND o.customer_id = ${customerId}::uuid`
    : [];

  const productIds = customerId
    ? (await db.customerFavorite.findMany({ where: { customerId }, select: { productId: true } })).map(
        (f) => f.productId,
      )
    : [];
  let interestCategories: string[] = [];
  if (orders.length > 0 || productIds.length > 0) {
    const items =
      orders.length > 0
        ? await db.orderItem.findMany({
            where: { orderId: { in: orders.map((o) => o.id) } },
            select: { variant: { select: { product: { select: { categoryId: true } } } } },
          })
        : [];
    const favorites =
      productIds.length > 0
        ? await db.product.findMany({ where: { id: { in: productIds } }, select: { categoryId: true } })
        : [];
    const categories = await db.category.findMany({ select: { id: true, slug: true, parentId: true } });
    const byId = new Map(categories.map((c) => [c.id, c]));
    const top = (id: number): string | null => {
      let node = byId.get(id);
      for (let depth = 0; node?.parentId != null && depth < MAX_DEPTH; depth++) node = byId.get(node.parentId);
      return node && node.parentId === null ? node.slug : null;
    };
    const categoryIds = [...items.map((i) => i.variant?.product.categoryId), ...favorites.map((p) => p.categoryId)];
    const slugs = categoryIds.flatMap((id) => {
      const slug = id === undefined ? null : top(id);
      return slug ? [slug] : [];
    });
    interestCategories = [...new Set(slugs)].sort();
  }

  const paidTimes = orders.flatMap((o) => (o.paid_at ? [o.paid_at.getTime()] : []));
  return {
    email: contact.email,
    firstName: customer ? (customer.fullName.trim().split(/\s+/)[0] ?? null) || null : null,
    tags: [contact.customerId ? 'member' : 'newsletter'],
    hasPurchased: orders.length > 0,
    lastPaidOrderAt: paidTimes.length > 0 ? new Date(Math.max(...paidTimes)).toISOString() : null,
    interestCategories,
  };
}
