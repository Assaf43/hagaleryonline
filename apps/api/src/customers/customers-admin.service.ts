import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  ADMIN_CUSTOMERS_PAGE_SIZE,
  ADMIN_CUSTOMERS_QUERY_MAX,
  CUSTOMER_PROFILE_ORDERS_MAX,
  type CodeTemplateOption,
  type ConsentEventAction,
  type ConsentEventSource,
  type CustomerConsentEvent,
  type CustomerPage,
  type CustomerProfile,
  type CustomerRow,
  type MarketingStatus as MarketingStatusView,
} from '@hg/models';
import {
  ConsentAction,
  CustomerOrigin,
  DiscountType,
  MarketingConsentSource,
  MarketingStatus,
  PromotionKind,
  type Prisma,
} from '../generated/prisma/client.js';
import { interestCategorySlugs, paidOrdersOf } from '../marketing/marketing-fields.js';
import { CHANNEL_VIEW, STATUS_VIEW } from '../orders/orders-admin.service.js';
import { effectiveStatus } from '../orders/orders.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PersonalCodesService } from '../promotions/personal-codes.service.js';
import { normalizePhone } from './contact-normalize.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `orders.number` is a PostgreSQL integer (int4). */
const MAX_ORDER_NUMBER = 2_147_483_647;

const ACTION_VIEW: Record<ConsentAction, ConsentEventAction> = {
  REQUESTED: 'requested',
  CONFIRMED: 'confirmed',
  WITHDRAWN: 'withdrawn',
  PROVIDER_UNSUBSCRIBED: 'provider_unsubscribed',
  RELEASED: 'released',
};
const SOURCE_VIEW: Record<MarketingConsentSource, ConsentEventSource> = {
  SIGNUP: 'signup',
  CHECKOUT: 'checkout',
  ACCOUNT: 'account',
  STORE: 'store',
  NEWSLETTER: 'newsletter',
};
const STATUS_MARKETING_VIEW: Record<MarketingStatus, MarketingStatusView> = {
  PENDING: 'pending',
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBED: 'unsubscribed',
};

const invalidInput = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });
const notFound = () => new NotFoundException({ statusCode: HttpStatus.NOT_FOUND, code: 'not_found' });

export interface CustomerListQuery {
  q: string;
  page: number;
}

/** The query of the list: `q` trimmed (up to 100 characters), `page` from 1. */
export function parseCustomerQuery(query: { q?: unknown; page?: unknown }): CustomerListQuery {
  let q = '';
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string' || query.q.length > ADMIN_CUSTOMERS_QUERY_MAX) throw invalidInput('q');
    q = query.q.trim();
  }
  let page = 1;
  if (query.page !== undefined && query.page !== '') {
    if (typeof query.page !== 'string' || !/^\d{1,6}$/.test(query.page) || Number(query.page) < 1)
      throw invalidInput('page');
    page = Number(query.page);
  }
  return { q, page };
}

/**
 * Which customers a search finds (spec §4.5): a name containing the text, a phone equal to it (any written form:
 * "050-123…", "+972…"), an e-mail containing it (any case), or an order number — the account that placed that order
 * (decision 77: a guest order belongs to no account, so its number finds nobody). Nothing typed: everyone.
 */
export function customerSearchWhere(q: string): Prisma.CustomerWhereInput {
  if (!q) return {};
  const or: Prisma.CustomerWhereInput[] = [
    { fullName: { contains: q, mode: 'insensitive' } },
    { email: { contains: q.toLowerCase() } },
  ];
  const phone = normalizePhone(q);
  if (phone) or.push({ phone });
  if (/^\d{1,10}$/.test(q) && Number(q) <= MAX_ORDER_NUMBER) or.push({ orders: { some: { number: Number(q) } } });
  return { OR: or };
}

/**
 * The admin customers list and profile (spec §4.5, CLB-09, `customers.view`). Reads only — nothing here is audited,
 * and nothing secret is read: no password hash, token hash or IP. The profile's orders are the account's own
 * (`customerId`), never guest orders matched by phone or e-mail (decision 77).
 */
@Injectable()
export class CustomersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: PersonalCodesService,
  ) {}

  async list({ q, page }: CustomerListQuery): Promise<CustomerPage> {
    const where = customerSearchWhere(q);
    const [total, rows] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * ADMIN_CUSTOMERS_PAGE_SIZE,
        take: ADMIN_CUSTOMERS_PAGE_SIZE,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          createdVia: true,
          createdAt: true,
          _count: { select: { orders: true } },
        },
      }),
    ]);
    const items: CustomerRow[] = rows.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      phone: c.phone,
      email: c.email,
      createdVia: c.createdVia === CustomerOrigin.STORE ? 'store' : 'web',
      createdAt: c.createdAt.toISOString(),
      orderCount: c._count.orders,
    }));
    return { items, total, page, pageSize: ADMIN_CUSTOMERS_PAGE_SIZE };
  }

  async profile(id: string): Promise<CustomerProfile> {
    if (!UUID.test(id)) throw notFound();
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        createdBySeller: { select: { id: true, name: true } },
        _count: { select: { orders: true } },
        marketingContact: {
          include: {
            events: {
              orderBy: [{ at: 'desc' }, { id: 'desc' }],
              select: {
                action: true,
                source: true,
                textVersion: true,
                actorCustomerId: true,
                actorSellerId: true,
                at: true,
              },
            },
          },
        },
      },
    });
    if (!customer) throw notFound();
    const now = new Date();
    const [orders, favorites, paid, codes] = await Promise.all([
      this.prisma.order.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        take: CUSTOMER_PROFILE_ORDERS_MAX,
        select: { number: true, createdAt: true, status: true, reservedUntil: true, total: true, channel: true },
      }),
      this.prisma.customerFavorite.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, product: { select: { id: true, modelName: true, nameHe: true } } },
      }),
      paidOrdersOf(this.prisma, id),
      this.codes.benefits(id, now),
    ]);
    const slugs = await interestCategorySlugs(
      this.prisma,
      id,
      paid.map((o) => o.id),
    );
    const names = slugs.length
      ? await this.prisma.category.findMany({ where: { slug: { in: slugs } }, select: { slug: true, nameHe: true } })
      : [];
    const nameOf = new Map(names.map((c) => [c.slug, c.nameHe]));

    const contact = customer.marketingContact;
    const history: CustomerConsentEvent[] = (contact?.events ?? []).map((e) => ({
      action: ACTION_VIEW[e.action],
      source: e.source ? SOURCE_VIEW[e.source] : null,
      textVersion: e.textVersion,
      actor: e.actorCustomerId ? 'customer' : e.actorSellerId !== null ? 'seller' : 'system',
      at: e.at.toISOString(),
    }));

    return {
      id: customer.id,
      fullName: customer.fullName,
      phone: customer.phone,
      phoneVerified: customer.phoneVerifiedAt !== null,
      email: customer.email,
      emailVerified: customer.email !== null && customer.emailVerifiedAt !== null,
      createdVia: customer.createdVia === CustomerOrigin.STORE ? 'store' : 'web',
      createdBySeller: customer.createdBySeller,
      createdAt: customer.createdAt.toISOString(),
      orders: orders.map((o) => ({
        number: o.number,
        createdAt: o.createdAt.toISOString(),
        status: STATUS_VIEW[effectiveStatus(o, now)],
        total: o.total,
        channel: CHANNEL_VIEW[o.channel],
      })),
      orderCount: customer._count.orders,
      favorites: favorites.map((f) => ({
        productId: f.product.id,
        modelName: f.product.modelName,
        nameHe: f.product.nameHe,
        addedAt: f.createdAt.toISOString(),
      })),
      interests: slugs.map((slug) => ({ slug, nameHe: nameOf.get(slug) ?? slug })),
      consent: {
        contact: contact
          ? {
              status: STATUS_MARKETING_VIEW[contact.status],
              source: SOURCE_VIEW[contact.source],
              consentAt: contact.consentAt?.toISOString() ?? null,
              unsubscribedAt: contact.unsubscribedAt?.toISOString() ?? null,
            }
          : null,
        history,
      },
      codes,
    };
  }

  /** The active personal-code templates (`club.manage`) the issue dialog offers: not off, not ended. */
  async codeTemplates(now = new Date()): Promise<CodeTemplateOption[]> {
    const rows = await this.prisma.promotion.findMany({
      where: {
        kind: PromotionKind.PERSONAL_TEMPLATE,
        active: true,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, discountType: true, value: true, minSubtotal: true, validityDays: true },
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      discountType: t.discountType === DiscountType.FIXED ? 'fixed' : 'percent',
      value: t.value,
      minSubtotal: t.minSubtotal,
      validityDays: t.validityDays ?? 0,
    }));
  }
}
