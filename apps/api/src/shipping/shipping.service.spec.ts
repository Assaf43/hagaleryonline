import type { PrismaService } from '../prisma/prisma.service.js';
import type { ShippingProvider } from './shipping-provider.js';
import type { ShippingRateRow } from './shipping-rules.js';
import {
  DEFAULT_SETTINGS,
  ShippingNotConfiguredError,
  ShippingService,
  type ShippingPriceList,
} from './shipping.service.js';

const ITEMS = [{ variantId: 1, topCategoryId: 3, quantity: 1 }];
const REQ = { localityId: 5000, floor: 0, hasElevator: false };

function service(rates: ShippingRateRow[]) {
  const quote = vi.fn().mockResolvedValue({ methods: [] });
  const prisma = { locality: { findUnique: vi.fn().mockResolvedValue({ id: 5000 }) } } as unknown as PrismaService;
  const priceList = {
    load: vi.fn().mockResolvedValue({ rates, settings: DEFAULT_SETTINGS }),
  } as unknown as ShippingPriceList;
  const provider = { code: 'manual', quote } as unknown as ShippingProvider;
  return { svc: new ShippingService(prisma, priceList, provider), quote };
}

const DEFAULT_ROW: ShippingRateRow = { categoryId: null, deliveryPrice: 15_000, assemblyPrice: 0 };
const CATEGORY_ROW: ShippingRateRow = { categoryId: 3, deliveryPrice: 30_000, assemblyPrice: 0 };

describe('ShippingService when shipping is not configured', () => {
  it('quote throws ShippingNotConfiguredError without a default row, even if a category has a rate', async () => {
    const { svc, quote } = service([CATEGORY_ROW]);
    await expect(svc.quote(ITEMS, REQ)).rejects.toBeInstanceOf(ShippingNotConfiguredError);
    expect(quote).not.toHaveBeenCalled();
  });

  it('shippingFrom is null without a default row', async () => {
    expect(await service([]).svc.shippingFrom(ITEMS)).toBeNull();
    expect(await service([CATEGORY_ROW]).svc.shippingFrom(ITEMS)).toBeNull();
  });

  it('quotes and prices normally with a default row', async () => {
    const { svc, quote } = service([DEFAULT_ROW]);
    await svc.quote(ITEMS, REQ);
    expect(quote).toHaveBeenCalled();
    expect(await svc.shippingFrom(ITEMS)).toBe(15_000);
  });
});
