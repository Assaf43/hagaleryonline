import { Injectable } from '@nestjs/common';
import {
  ACCOUNT_ORDERS_PAGE_SIZE,
  MAX_CUSTOMER_ADDRESSES,
  ORDER_STATUS_LABELS_HE,
  type AccountConsent,
  type AccountOrdersPage,
  type CustomerAddressInput,
  type CustomerAddressView,
  type MarketingConsentSource as ConsentSourceView,
  type OrderView,
} from '@hg/models';
import { MarketingConsentSource, type Customer, type Prisma } from '../generated/prisma/client.js';
import { MESSAGES, parseCheckoutAddress } from '../orders/checkout.service.js';
import { OrderLifecycleService } from '../orders/order-lifecycle.service.js';
import { fieldError } from '../orders/order-errors.js';
import { effectiveStatus, OrdersService, STATUS_VIEW } from '../orders/orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accountNotFound, addressLimit, badField } from './account-errors.js';
import { listAddresses, toView } from './address-view.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_VIEW: Record<MarketingConsentSource, ConsentSourceView> = {
  SIGNUP: 'signup',
  CHECKOUT: 'checkout',
  ACCOUNT: 'account',
};

/**
 * The account's own data (spec §6.3, ACC-03, ACC-04, ACC-05): saved addresses, order history, the cancel of an
 * unpaid order, and marketing consent. Every read and write is scoped to the signed-in customer's id; another
 * account's address or order answers 404, the same as an unknown one. Orders are only those placed while signed in
 * (`customerId`): nothing here looks orders up by phone or e-mail (decision 77).
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  addresses(customerId: string): Promise<CustomerAddressView[]> {
    return listAddresses(this.prisma, customerId);
  }

  /** The first address is the default; `isDefault: true` moves the default to it. */
  async createAddress(customerId: string, body: unknown): Promise<CustomerAddressView> {
    const input = await this.parseAddress(body);
    return this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const count = await tx.customerAddress.count({ where: { customerId } });
      if (count >= MAX_CUSTOMER_ADDRESSES) throw addressLimit();
      const isDefault = count === 0 || input.isDefault === true;
      if (isDefault) await clearDefault(tx, customerId);
      const row = await tx.customerAddress.create({
        data: { customerId, ...addressData(input), isDefault },
        include: { locality: { select: { nameHe: true } } },
      });
      return toView(row);
    });
  }

  /** `isDefault: true` makes it the default; the current default stays the default otherwise (one always exists). */
  async updateAddress(customerId: string, id: string, body: unknown): Promise<CustomerAddressView> {
    if (!UUID.test(id)) throw accountNotFound();
    const input = await this.parseAddress(body);
    return this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const existing = await tx.customerAddress.findFirst({ where: { id, customerId } });
      if (!existing) throw accountNotFound();
      const isDefault = existing.isDefault || input.isDefault === true;
      if (isDefault && !existing.isDefault) await clearDefault(tx, customerId);
      const row = await tx.customerAddress.update({
        where: { id },
        data: { ...addressData(input), isDefault },
        include: { locality: { select: { nameHe: true } } },
      });
      return toView(row);
    });
  }

  /** Deleting the default makes the newest remaining address the default. */
  async deleteAddress(customerId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw accountNotFound();
    await this.prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const existing = await tx.customerAddress.findFirst({ where: { id, customerId } });
      if (!existing) throw accountNotFound();
      await tx.customerAddress.delete({ where: { id } });
      if (!existing.isDefault) return;
      const next = await tx.customerAddress.findFirst({
        where: { customerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (next) await tx.customerAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    });
  }

  /** The account's orders, newest first (`page` from 1). */
  async orderPage(customerId: string, pageParam: unknown): Promise<AccountOrdersPage> {
    const page = parsePage(pageParam);
    const pageSize = ACCOUNT_ORDERS_PAGE_SIZE;
    const where: Prisma.OrderWhereInput = { customerId };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { number: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          number: true,
          status: true,
          reservedUntil: true,
          createdAt: true,
          total: true,
          items: { select: { quantity: true } },
        },
      }),
    ]);
    const now = new Date();
    return {
      items: rows.map((o) => {
        const status = STATUS_VIEW[effectiveStatus(o, now)];
        return {
          number: o.number,
          status,
          statusLabelHe: ORDER_STATUS_LABELS_HE[status],
          createdAt: o.createdAt.toISOString(),
          total: o.total,
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
        };
      }),
      page,
      pageSize,
      total,
    };
  }

  order(customerId: string, number: string): Promise<OrderView> {
    return this.orders.view(number, { customerId });
  }

  /** The same cancel as the order link's (unpaid orders only, spec §4.2), authorized by the account. */
  cancelOrder(customerId: string, number: string): Promise<OrderView> {
    return this.lifecycle.cancelByCustomer(number, { customerId });
  }

  /**
   * Marketing consent (CLAUDE.md §4.4): giving it records the time and source `account` and clears an earlier
   * withdrawal; withdrawing records the withdrawal time (the consent's time and source stay as the record of it). The
   * current value: no change.
   */
  async setConsent(customer: Customer, body: unknown): Promise<AccountConsent> {
    const value = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}).marketingConsent;
    if (typeof value !== 'boolean') throw badField('marketingConsent');
    const now = new Date();
    const data: Prisma.CustomerUpdateManyMutationInput = value
      ? {
          marketingConsent: true,
          marketingConsentAt: now,
          marketingConsentSource: MarketingConsentSource.ACCOUNT,
          marketingWithdrawnAt: null,
        }
      : { marketingConsent: false, marketingWithdrawnAt: now };
    // Only when it changes: a repeated answer keeps the recorded times.
    await this.prisma.customer.updateMany({ where: { id: customer.id, marketingConsent: !value }, data });
    return consentView(await this.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }));
  }

  /** The checkout's address rules, the locality must exist, and an optional boolean `isDefault`. */
  private async parseAddress(body: unknown): Promise<CustomerAddressInput> {
    const address = parseCheckoutAddress(body);
    const isDefault = (body as Record<string, unknown>).isDefault;
    if (isDefault !== undefined && typeof isDefault !== 'boolean') throw badField('isDefault');
    const locality = await this.prisma.locality.findUnique({ where: { id: address.localityId }, select: { id: true } });
    if (!locality) throw fieldError('address.localityId', MESSAGES['address.localityId']);
    return { ...address, isDefault };
  }
}

/** Serializes one account's address writes, so exactly one default survives concurrent saves. */
async function lockCustomer(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR NO KEY UPDATE`;
}

async function clearDefault(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.customerAddress.updateMany({ where: { customerId, isDefault: true }, data: { isDefault: false } });
}

function addressData(input: CustomerAddressInput) {
  const { localityId, street, houseNumber, apartment, floor, hasElevator, notes } = input;
  return { localityId, street, houseNumber, apartment, floor, hasElevator, notes };
}

function consentView(c: Customer): AccountConsent {
  return {
    marketingConsent: c.marketingConsent,
    marketingConsentAt: c.marketingConsentAt?.toISOString() ?? null,
    marketingConsentSource: c.marketingConsentSource ? SOURCE_VIEW[c.marketingConsentSource] : null,
    marketingWithdrawnAt: c.marketingWithdrawnAt?.toISOString() ?? null,
  };
}

/** `?page=` from 1 (missing: 1); 400 `invalid_input` with `field: 'page'` otherwise. */
function parsePage(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value)) throw badField('page');
  return Number(value);
}
