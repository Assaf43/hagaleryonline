import { MarketingStatus, type MarketingContact } from '../generated/prisma/client.js';
import { marketingFields, type FieldsDb } from './marketing-fields.js';

const contact = (over: Partial<MarketingContact> = {}): MarketingContact => ({
  id: 'c-1',
  email: 'dana@x.test',
  customerId: null,
  status: MarketingStatus.SUBSCRIBED,
  source: 'NEWSLETTER',
  consentAt: new Date(),
  unsubscribedAt: null,
  confirmTokenHash: null,
  confirmExpiresAt: null,
  unsubscribeTokenHash: 'h',
  syncVersion: 1,
  syncedVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** Categories: sofas (top) → corner-sofas → recliners (two levels down), tables (top). */
const CATEGORIES = [
  { id: 1, slug: 'sofas', parentId: null },
  { id: 2, slug: 'corner-sofas', parentId: 1 },
  { id: 3, slug: 'tables', parentId: null },
  { id: 4, slug: 'recliners', parentId: 2 },
];

function fakeDb(orders: { id: string; paidAt: Date | null; categoryIds: (number | null)[] }[], fullName?: string) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue(orders.map((o) => ({ id: o.id, paid_at: o.paidAt }))),
    customer: { findUnique: vi.fn().mockResolvedValue(fullName ? { fullName } : null) },
    category: { findMany: vi.fn().mockResolvedValue(CATEGORIES) },
    orderItem: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          orders.flatMap((o) =>
            o.categoryIds.map((c) => ({ variant: c === null ? null : { product: { categoryId: c } } })),
          ),
        ),
    },
  };
  return db as unknown as FieldsDb & typeof db;
}

describe('marketingFields', () => {
  it('fields for a newsletter contact', async () => {
    const db = fakeDb([]);
    expect(await marketingFields(db, contact())).toEqual({
      email: 'dana@x.test',
      firstName: null,
      tags: ['newsletter'],
      hasPurchased: false,
      lastPaidOrderAt: null,
      interestCategories: [],
    });
    expect(db.customer.findUnique).not.toHaveBeenCalled();
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('a linked contact is a member with the first word of the account name', async () => {
    const db = fakeDb([], '  דנה   לוי ');
    const fields = await marketingFields(db, contact({ customerId: 'cust-1' }));
    expect(fields.tags).toEqual(['member']);
    expect(fields.firstName).toBe('דנה');
  });

  it('interests are top-level slugs, deduplicated', async () => {
    const early = new Date('2026-10-01T10:00:00Z');
    const late = new Date('2026-11-02T08:30:00Z');
    const db = fakeDb([
      { id: 'o-1', paidAt: early, categoryIds: [2, 4, null] },
      { id: 'o-2', paidAt: late, categoryIds: [3, 1, 3] },
    ]);
    const fields = await marketingFields(db, contact());
    expect(fields.interestCategories).toEqual(['sofas', 'tables']);
    expect(fields.hasPurchased).toBe(true);
    expect(fields.lastPaidOrderAt).toBe(late.toISOString());
  });
});
