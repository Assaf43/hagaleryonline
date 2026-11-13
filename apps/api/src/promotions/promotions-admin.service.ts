import { Injectable } from '@nestjs/common';
import {
  PROMOTION_KIND_LABELS_HE,
  PROMOTION_TARGET_LABELS_HE,
  type AdminPromotion,
  type AdminPromotionInput,
  type DiscountType,
  type PromotionCategoryOption,
  type PromotionKind,
  type PromotionTarget,
  type PromotionTargetRef,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { duplicate, invalid, notFound } from '../catalog-admin/catalog-errors.js';
import {
  DiscountType as DbDiscountType,
  Prisma,
  PromotionKind as DbPromotionKind,
  PromotionTarget as DbPromotionTarget,
  type Promotion,
} from '../generated/prisma/client.js';
import { thumbUrl } from '../media/image-urls.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { auditDiff, shekels, type AuditView } from '../shipping/shipping-audit.js';
import { toRule } from './promotions.service.js';

type Meta = { actorId: number; ip?: string };

/** The admin's name for the welcome benefit (spec §6.4), also its audit key. */
const WELCOME_LABEL = 'הטבת הצטרפות';
type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const KIND_TO_DB: Record<PromotionKind, DbPromotionKind> = {
  automatic: DbPromotionKind.AUTOMATIC,
  coupon: DbPromotionKind.COUPON,
};
const TYPE_TO_DB: Record<DiscountType, DbDiscountType> = {
  percent: DbDiscountType.PERCENT,
  fixed: DbDiscountType.FIXED,
};
const TARGET_TO_DB: Record<PromotionTarget, DbPromotionTarget> = {
  order: DbPromotionTarget.ORDER,
  categories: DbPromotionTarget.CATEGORIES,
  products: DbPromotionTarget.PRODUCTS,
};

const firstImage = {
  orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] satisfies Prisma.ImageOrderByWithRelationInput[],
  take: 1,
  select: { url: true, storageKey: true, widths: true },
};

const ISRAEL_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * "מבצעים וקופונים" in the admin (spec §6, ADM-05, permission promotions.manage): list, create, edit and
 * deactivate — there is no delete (orders keep a link to their promotion). Every change is audited in the same
 * transaction with a readable before/after. The cart and checkout read promotions from the database on every
 * request (`PromotionsService`, no cache), so a save applies at once.
 */
@Injectable()
export class PromotionsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
  ) {}

  /** Newest first. */
  async list(): Promise<AdminPromotion[]> {
    const rows = await this.prisma.promotion.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return this.views(this.prisma, rows);
  }

  async get(id: number): Promise<AdminPromotion> {
    const row = await this.prisma.promotion.findUnique({ where: { id } });
    if (!row) throw notFound();
    return (await this.views(this.prisma, [row]))[0];
  }

  /** Every category in tree order (children right after their parent), for the category picker. */
  async categories(): Promise<PromotionCategoryOption[]> {
    const all = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, nameHe: true, parentId: true },
    });
    const children = new Map<number | null, typeof all>();
    for (const c of all) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
    const out: PromotionCategoryOption[] = [];
    const walk = (parentId: number | null, depth: number) => {
      for (const c of children.get(parentId) ?? []) {
        out.push({ id: c.id, nameHe: c.nameHe, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  async create(input: AdminPromotionInput, meta: Meta): Promise<AdminPromotion> {
    return this.inTx(input, async (tx) => {
      if (input.isWelcome) await this.takeWelcome(tx, null, meta);
      await this.check(tx, input, null);
      const row = await tx.promotion.create({ data: toData(input) });
      const view = (await this.views(tx, [row]))[0];
      await this.audit.record(
        { ...meta, action: 'promotion.create', entityType: 'promotion', entityId: row.id, after: auditView(view) },
        tx,
      );
      return view;
    });
  }

  async update(id: number, input: AdminPromotionInput, meta: Meta): Promise<AdminPromotion> {
    return this.inTx(input, async (tx) => {
      if (input.isWelcome) await this.takeWelcome(tx, id, meta);
      const existing = await this.locked(tx, id);
      await this.check(tx, input, id);
      const before = (await this.views(tx, [existing]))[0];
      const row = await tx.promotion.update({ where: { id }, data: toData(input) });
      const view = (await this.views(tx, [row]))[0];
      const change = auditDiff(auditView(before), auditView(view));
      if (change)
        await this.audit.record(
          { ...meta, action: 'promotion.update', entityType: 'promotion', entityId: id, ...change },
          tx,
        );
      return view;
    });
  }

  /** Turns a promotion off (no delete: orders keep a link to it). Already off: unchanged, nothing audited. */
  async deactivate(id: number, meta: Meta): Promise<AdminPromotion> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.locked(tx, id);
      if (!existing.active) return (await this.views(tx, [existing]))[0];
      const row = await tx.promotion.update({ where: { id }, data: { active: false } });
      await this.audit.record(
        {
          ...meta,
          action: 'promotion.deactivate',
          entityType: 'promotion',
          entityId: id,
          before: { פעיל: 'כן' },
          after: { פעיל: 'לא' },
        },
        tx,
      );
      return (await this.views(tx, [row]))[0];
    });
  }

  /**
   * Marking a promotion as the welcome benefit clears the mark on every other promotion first (each change audited),
   * so the partial unique index (one active welcome promotion) holds. Welcome saves run one at a time (an advisory
   * lock), and the rows involved are locked in ascending id order, like a checkout's promotion locks (locks.ts).
   */
  private async takeWelcome(tx: Tx, id: number | null, meta: Meta): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('promotions:welcome'))`;
    await tx.$queryRaw`SELECT id FROM promotions WHERE is_welcome OR id = ${id ?? 0} ORDER BY id FOR UPDATE`;
    const others = await tx.promotion.findMany({
      where: { isWelcome: true, ...(id === null ? {} : { id: { not: id } }) },
      select: { id: true },
    });
    for (const other of others) {
      await tx.promotion.update({ where: { id: other.id }, data: { isWelcome: false } });
      await this.audit.record(
        {
          ...meta,
          action: 'promotion.update',
          entityType: 'promotion',
          entityId: other.id,
          before: { [WELCOME_LABEL]: 'כן' },
          after: { [WELCOME_LABEL]: 'לא' },
        },
        tx,
      );
    }
  }

  /** The row, locked for this save (two saves of one promotion run one after the other). */
  private async locked(tx: Tx, id: number): Promise<Promotion> {
    await tx.$queryRaw`SELECT id FROM promotions WHERE id = ${id} FOR UPDATE`;
    const row = await tx.promotion.findUnique({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  /** 409 for a code another promotion has; 400 for a target that does not exist. */
  private async check(tx: Tx, input: AdminPromotionInput, id: number | null): Promise<void> {
    if (input.code) {
      const taken = await tx.promotion.findUnique({ where: { code: input.code }, select: { id: true } });
      if (taken && taken.id !== id) throw duplicate('code', input.code);
    }
    const ids = input.targetIds;
    if (input.target === 'categories' && (await tx.category.count({ where: { id: { in: ids } } })) !== ids.length)
      throw invalid('targetIds');
    if (input.target === 'products' && (await tx.product.count({ where: { id: { in: ids } } })) !== ids.length)
      throw invalid('targetIds');
  }

  /** Two saves of the same new code at once: the unique index refuses the second — still a 409 on the code. */
  private async inTx<T>(input: AdminPromotionInput, work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && input.code)
        throw duplicate('code', input.code);
      throw e;
    }
  }

  /** Admin views with the names of their targets (two queries for any number of rows). */
  private async views(db: Db, rows: Promotion[]): Promise<AdminPromotion[]> {
    const ids = (target: DbPromotionTarget) => [
      ...new Set(rows.filter((r) => r.target === target).flatMap((r) => r.targetIds)),
    ];
    const categoryIds = ids(DbPromotionTarget.CATEGORIES);
    const productIds = ids(DbPromotionTarget.PRODUCTS);
    const [categories, products] = await Promise.all([
      categoryIds.length
        ? db.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, nameHe: true } })
        : [],
      productIds.length
        ? db.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, nameHe: true, modelName: true, active: true, images: firstImage },
          })
        : [],
    ]);
    const categoryRefs = new Map<number, PromotionTargetRef>(
      categories.map((c) => [c.id, { id: c.id, nameHe: c.nameHe, modelName: null, active: true, thumbnailUrl: null }]),
    );
    const productRefs = new Map<number, PromotionTargetRef>(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          nameHe: p.nameHe,
          modelName: p.modelName,
          active: p.active,
          thumbnailUrl: p.images[0] ? thumbUrl(this.storage, p.images[0]) : null,
        },
      ]),
    );
    return rows.map((r) => {
      const rule = toRule(r);
      const refs = r.target === DbPromotionTarget.PRODUCTS ? productRefs : categoryRefs;
      return {
        id: r.id,
        name: r.name,
        kind: rule.kind,
        code: r.code,
        discountType: rule.discountType,
        value: r.value,
        target: rule.target,
        // A target deleted since is left out (it can no longer match a cart line).
        targets: r.targetIds.flatMap((id) => refs.get(id) ?? []),
        minSubtotal: r.minSubtotal,
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
        usageLimit: r.usageLimit,
        usedCount: r.usedCount,
        active: r.active,
        isWelcome: r.isWelcome,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }
}

function toData(input: AdminPromotionInput) {
  return {
    name: input.name,
    kind: KIND_TO_DB[input.kind],
    code: input.code,
    discountType: TYPE_TO_DB[input.discountType],
    value: input.value,
    target: TARGET_TO_DB[input.target],
    targetIds: input.targetIds,
    minSubtotal: input.minSubtotal,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    usageLimit: input.usageLimit,
    active: input.active,
    isWelcome: input.isWelcome === true,
  };
}

/** "1/12/2026, 00:00" in Israel time; "ללא" when not set. */
const israelTime = (iso: string | null) => (iso ? ISRAEL_TIME.format(new Date(iso)) : 'ללא');

/** What the audit log keeps of a promotion (ADM-11): Hebrew keys and readable values, as for shipping. */
export function auditView(p: AdminPromotion): AuditView {
  const targets =
    p.target === 'order'
      ? PROMOTION_TARGET_LABELS_HE.order
      : `${PROMOTION_TARGET_LABELS_HE[p.target]}: ${p.targets.map((t) => t.modelName ?? t.nameHe).join(', ')}`;
  return {
    שם: p.name,
    סוג: PROMOTION_KIND_LABELS_HE[p.kind],
    קוד: p.code ?? 'ללא',
    הנחה: p.discountType === 'percent' ? `${p.value}%` : shekels(p.value),
    'חל על': targets,
    'סכום מינימום': shekels(p.minSubtotal),
    התחלה: israelTime(p.startsAt),
    סיום: israelTime(p.endsAt),
    'מגבלת שימוש': p.usageLimit === null ? 'ללא הגבלה' : String(p.usageLimit),
    פעיל: p.active ? 'כן' : 'לא',
    [WELCOME_LABEL]: p.isWelcome ? 'כן' : 'לא',
  };
}
