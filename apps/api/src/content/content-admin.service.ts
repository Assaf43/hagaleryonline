import { Injectable } from '@nestjs/common';
import type {
  AuditAction,
  AuditEntityType,
  AdminAnnouncement,
  AdminAnnouncementInput,
  AdminFaqGroup,
  AdminFaqGroupInput,
  AdminInfoPage,
  AdminInfoPageInput,
  AdminSiteContent,
  AdminSiteContentInput,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import {
  Prisma,
  type Announcement,
  type FaqGroup,
  type FaqItem,
  type InfoPage,
  type SiteContent,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuditView } from '../shipping/shipping-audit.js';
import { recordContentChange, type ContentMeta } from './content-audit.js';
import { CONTENT_CACHE_PREFIX } from './content.service.js';
import { conflict, invalid, notFound, slugTaken, systemPageDelete, systemPageField } from './content-errors.js';

type Meta = ContentMeta;
type Tx = Prisma.TransactionClient;
type GroupWithItems = FaqGroup & { items: FaqItem[] };

const itemOrder = { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } satisfies Prisma.FaqGroup$itemsArgs;

/**
 * The admin "תוכן" screens for 8a (Phase 8 §5, ADM-06, permission content.manage): site details, announcements,
 * info pages and FAQ groups. Every update sends the `updatedAt` it started from (`expectedUpdatedAt`) and is refused
 * with 409 `conflict` when the row was saved since (the row is locked first, like products). Every change is audited
 * in its transaction (`content.<entity>.<create|update|delete>`, readable Hebrew-keyed before / after) and clears the
 * `content:` cache, so the public answer changes right away. A save clears the seeded "interim" mark (decision 100).
 */
@Injectable()
export class ContentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
  ) {}

  /** Runs a write and clears the public content cache after it committed (also when it failed half-way: harmless). */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } finally {
      await this.cache.invalidate(CONTENT_CACHE_PREFIX);
    }
  }

  // ---- Site details ----

  async site(): Promise<AdminSiteContent> {
    const row = await this.prisma.siteContent.findUnique({ where: { id: 1 } });
    if (!row) throw notFound();
    return siteView(row);
  }

  async updateSite(input: AdminSiteContentInput, expected: string, meta: Meta): Promise<AdminSiteContent> {
    return this.write(async (tx) => {
      const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM site_content WHERE id = 1 FOR UPDATE`;
      if (rows.length === 0) throw notFound();
      const existing = await tx.siteContent.findUniqueOrThrow({ where: { id: 1 } });
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      const row = await tx.siteContent.update({
        where: { id: 1 },
        data: {
          supportPhone: input.supportPhone,
          supportEmail: input.supportEmail,
          whatsapp: input.whatsapp,
          shippingHtml: input.shippingHtml,
          interim: false,
        },
      });
      await this.record(tx, meta, 'content.site.update', 'site_content', 1, siteAudit(existing), siteAudit(row));
      return siteView(row);
    });
  }

  // ---- Announcements ----

  /** Lowest order first, then the newest. */
  async announcements(): Promise<AdminAnnouncement[]> {
    const rows = await this.prisma.announcement.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }] });
    return rows.map(announcementView);
  }

  async announcement(id: number): Promise<AdminAnnouncement> {
    const row = await this.prisma.announcement.findUnique({ where: { id } });
    if (!row) throw notFound();
    return announcementView(row);
  }

  async createAnnouncement(input: AdminAnnouncementInput, meta: Meta): Promise<AdminAnnouncement> {
    return this.write(async (tx) => {
      const row = await tx.announcement.create({ data: announcementData(input) });
      await this.record(tx, meta, 'content.announcement.create', 'announcement', row.id, null, announcementAudit(row));
      return announcementView(row);
    });
  }

  /** The version goes up when the text or the link (address or label) changes — not for dates, order or the switch. */
  async updateAnnouncement(
    id: number,
    input: AdminAnnouncementInput,
    expected: string,
    meta: Meta,
  ): Promise<AdminAnnouncement> {
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM announcements WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.announcement.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      const changed =
        existing.textHe !== input.textHe ||
        existing.linkUrl !== input.linkUrl ||
        existing.linkLabelHe !== input.linkLabelHe;
      const row = await tx.announcement.update({
        where: { id },
        data: { ...announcementData(input), version: changed ? existing.version + 1 : existing.version },
      });
      await this.record(
        tx,
        meta,
        'content.announcement.update',
        'announcement',
        id,
        announcementAudit(existing),
        announcementAudit(row),
      );
      return announcementView(row);
    });
  }

  async deleteAnnouncement(id: number, meta: Meta): Promise<void> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM announcements WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.announcement.findUnique({ where: { id } });
      if (!existing) throw notFound();
      await tx.announcement.delete({ where: { id } });
      await this.record(tx, meta, 'content.announcement.delete', 'announcement', id, announcementAudit(existing), null);
    });
  }

  // ---- Info pages ----

  /** System pages first, then the others, each in footer order. */
  async pages(): Promise<AdminInfoPage[]> {
    const rows = await this.prisma.infoPage.findMany({ orderBy: [{ footerOrder: 'asc' }, { id: 'asc' }] });
    return rows.sort((a, b) => Number(b.systemKey !== null) - Number(a.systemKey !== null)).map(pageView);
  }

  async page(id: number): Promise<AdminInfoPage> {
    const row = await this.prisma.infoPage.findUnique({ where: { id } });
    if (!row) throw notFound();
    return pageView(row);
  }

  async createPage(input: AdminInfoPageInput, meta: Meta): Promise<AdminInfoPage> {
    return this.write(async (tx) => {
      await this.checkSlug(tx, input.slug, null);
      const row = await tx.infoPage.create({ data: pageData(input) }).catch(slugToTaken);
      await this.record(tx, meta, 'content.page.create', 'info_page', row.id, null, pageAudit(row));
      return pageView(row);
    });
  }

  /** A system page keeps its slug and stays published (the checkout and the footer link to it). */
  async updatePage(id: number, input: AdminInfoPageInput, expected: string, meta: Meta): Promise<AdminInfoPage> {
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM info_pages WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.infoPage.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      if (existing.systemKey !== null) {
        if (input.slug !== existing.slug) throw systemPageField('slug');
        if (!input.published) throw systemPageField('published');
      }
      await this.checkSlug(tx, input.slug, id);
      const row = await tx.infoPage
        .update({ where: { id }, data: { ...pageData(input), interim: false } })
        .catch(slugToTaken);
      await this.record(tx, meta, 'content.page.update', 'info_page', id, pageAudit(existing), pageAudit(row));
      return pageView(row);
    });
  }

  async deletePage(id: number, meta: Meta): Promise<void> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM info_pages WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.infoPage.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.systemKey !== null) throw systemPageDelete();
      await tx.infoPage.delete({ where: { id } });
      await this.record(tx, meta, 'content.page.delete', 'info_page', id, pageAudit(existing), null);
    });
  }

  private async checkSlug(tx: Tx, slug: string, id: number | null): Promise<void> {
    const other = await tx.infoPage.findUnique({ where: { slug }, select: { id: true } });
    if (other && other.id !== id) throw slugTaken();
  }

  // ---- FAQ ----

  async faqGroups(): Promise<AdminFaqGroup[]> {
    const rows = await this.prisma.faqGroup.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { items: itemOrder },
    });
    return rows.map(groupView);
  }

  async faqGroup(id: number): Promise<AdminFaqGroup> {
    const row = await this.prisma.faqGroup.findUnique({ where: { id }, include: { items: itemOrder } });
    if (!row) throw notFound();
    return groupView(row);
  }

  async createFaqGroup(input: AdminFaqGroupInput, meta: Meta): Promise<AdminFaqGroup> {
    return this.write(async (tx) => {
      // Items of a new group are all new.
      input.items.forEach((item, i) => {
        if (item.id !== undefined) throw invalid(`items.${i}.id`);
      });
      const created = await tx.faqGroup.create({
        data: {
          titleHe: input.titleHe,
          sortOrder: input.sortOrder,
          published: input.published,
          items: { create: input.items.map((item, i) => itemData(item, i)) },
        },
        include: { items: itemOrder },
      });
      await this.record(tx, meta, 'content.faq.create', 'faq_group', created.id, null, groupAudit(created));
      return groupView(created);
    });
  }

  /**
   * The group with all its items in one save: items with an id are updated (they must belong to this group), items
   * without one are created, items not sent are deleted; the order is the array order.
   */
  async updateFaqGroup(id: number, input: AdminFaqGroupInput, expected: string, meta: Meta): Promise<AdminFaqGroup> {
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM faq_groups WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.faqGroup.findUnique({ where: { id }, include: { items: itemOrder } });
      if (!existing) throw notFound();
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      const own = new Set(existing.items.map((i) => i.id));
      input.items.forEach((item, i) => {
        if (item.id !== undefined && !own.has(item.id)) throw invalid(`items.${i}.id`);
      });
      const kept = new Set(input.items.flatMap((i) => (i.id === undefined ? [] : [i.id])));
      await tx.faqItem.deleteMany({ where: { groupId: id, id: { notIn: [...kept] } } });
      for (const [i, item] of input.items.entries()) {
        if (item.id === undefined) await tx.faqItem.create({ data: { ...itemData(item, i), groupId: id } });
        else await tx.faqItem.update({ where: { id: item.id }, data: itemData(item, i) });
      }
      // updatedAt is set explicitly: a save that changes only items still moves the group's stamp.
      const row = await tx.faqGroup.update({
        where: { id },
        data: { titleHe: input.titleHe, sortOrder: input.sortOrder, published: input.published, updatedAt: new Date() },
        include: { items: itemOrder },
      });
      await this.record(tx, meta, 'content.faq.update', 'faq_group', id, groupAudit(existing), groupAudit(row));
      return groupView(row);
    });
  }

  async deleteFaqGroup(id: number, meta: Meta): Promise<void> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM faq_groups WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.faqGroup.findUnique({ where: { id }, include: { items: itemOrder } });
      if (!existing) throw notFound();
      await tx.faqGroup.delete({ where: { id } });
      await this.record(tx, meta, 'content.faq.delete', 'faq_group', id, groupAudit(existing), null);
    });
  }

  // ---- Audit ----

  private record(
    tx: Tx,
    meta: Meta,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId: number,
    before: AuditView | null,
    after: AuditView | null,
  ): Promise<void> {
    return recordContentChange(this.audit, tx, meta, action, entityType, entityId, before, after);
  }
}

function slugToTaken(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw slugTaken();
  throw e;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const yesNo = (b: boolean) => (b ? 'כן' : 'לא');

function siteView(row: SiteContent): AdminSiteContent {
  return {
    supportPhone: row.supportPhone,
    supportEmail: row.supportEmail,
    whatsapp: row.whatsapp,
    shippingHtml: row.shippingHtml,
    interim: row.interim,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function siteAudit(row: SiteContent): AuditView {
  return {
    טלפון: row.supportPhone,
    'דוא"ל': row.supportEmail,
    וואטסאפ: row.whatsapp,
    'טקסט משלוח': row.shippingHtml,
  };
}

function announcementData(input: AdminAnnouncementInput) {
  return {
    textHe: input.textHe,
    linkUrl: input.linkUrl,
    linkLabelHe: input.linkLabelHe,
    active: input.active,
    sortOrder: input.sortOrder,
    startsAt: input.startsAt === null ? null : new Date(input.startsAt),
    endsAt: input.endsAt === null ? null : new Date(input.endsAt),
  };
}

function announcementView(row: Announcement): AdminAnnouncement {
  return {
    id: row.id,
    textHe: row.textHe,
    linkUrl: row.linkUrl,
    linkLabelHe: row.linkLabelHe,
    active: row.active,
    sortOrder: row.sortOrder,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function announcementAudit(row: Announcement): AuditView {
  return {
    טקסט: row.textHe,
    קישור: row.linkUrl ?? '',
    'טקסט הקישור': row.linkLabelHe ?? '',
    פעיל: yesNo(row.active),
    סדר: String(row.sortOrder),
    התחלה: iso(row.startsAt) ?? '',
    סיום: iso(row.endsAt) ?? '',
    גרסה: String(row.version),
  };
}

function pageData(input: AdminInfoPageInput) {
  return {
    slug: input.slug,
    titleHe: input.titleHe,
    bodyHtml: input.bodyHtml,
    metaDescriptionHe: input.metaDescriptionHe,
    published: input.published,
    noindex: input.noindex,
    showInFooter: input.showInFooter,
    footerLabelHe: input.footerLabelHe,
    footerOrder: input.footerOrder,
  };
}

function pageView(row: InfoPage): AdminInfoPage {
  return {
    id: row.id,
    slug: row.slug,
    systemKey: row.systemKey,
    titleHe: row.titleHe,
    bodyHtml: row.bodyHtml,
    metaDescriptionHe: row.metaDescriptionHe,
    published: row.published,
    noindex: row.noindex,
    showInFooter: row.showInFooter,
    footerLabelHe: row.footerLabelHe,
    footerOrder: row.footerOrder,
    interim: row.interim,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function pageAudit(row: InfoPage): AuditView {
  return {
    כותרת: row.titleHe,
    כתובת: `/info/${row.slug}`,
    תוכן: row.bodyHtml,
    'תיאור לגוגל': row.metaDescriptionHe ?? '',
    מפורסם: yesNo(row.published),
    'ללא אינדוקס': yesNo(row.noindex),
    'בכותרת התחתונה': yesNo(row.showInFooter),
    'שם בכותרת התחתונה': row.footerLabelHe ?? '',
    'סדר בכותרת התחתונה': String(row.footerOrder),
  };
}

function itemData(item: AdminFaqGroupInput['items'][number], index: number) {
  return { questionHe: item.questionHe, answerHtml: item.answerHtml, published: item.published, sortOrder: index };
}

function groupView(row: GroupWithItems): AdminFaqGroup {
  return {
    id: row.id,
    titleHe: row.titleHe,
    sortOrder: row.sortOrder,
    published: row.published,
    items: row.items.map((i) => ({
      id: i.id,
      questionHe: i.questionHe,
      answerHtml: i.answerHtml,
      sortOrder: i.sortOrder,
      published: i.published,
    })),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Flat and readable: one key per question ("שאלה 1"), its answer and whether it shows. */
function groupAudit(row: GroupWithItems): AuditView {
  const view: AuditView = { כותרת: row.titleHe, סדר: String(row.sortOrder), מפורסם: yesNo(row.published) };
  row.items.forEach((item, i) => {
    view[`שאלה ${i + 1}`] = item.questionHe;
    view[`תשובה ${i + 1}`] = item.answerHtml;
    view[`שאלה ${i + 1} מפורסמת`] = yesNo(item.published);
  });
  return view;
}
