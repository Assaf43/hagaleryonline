import { Injectable } from '@nestjs/common';
import type { AdminBanner, AdminBannerInput } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { HomeSectionKind, type Banner, type Prisma } from '../generated/prisma/client.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuditView } from '../shipping/shipping-audit.js';
import { recordContentChange, type ContentMeta } from './content-audit.js';
import { bannerImages, contentImageRef, type BannerWithImages } from './content-image-ref.js';
import { bannerInUse, conflict, invalid, notFound } from './content-errors.js';
import { CONTENT_CACHE_PREFIX } from './content.service.js';
import { bannerIdsOf, homeSectionName, KIND, storedConfig } from './home/home-config.js';

type Tx = Prisma.TransactionClient;

/**
 * Banners in the admin (Phase 8 §4.5, §5, NAV-05, ADM-06; content.manage). A banner points at content photos uploaded
 * first (`ContentImagesService`); the photo rows are Restrict-linked, so a photo in use cannot go away. Every update
 * sends `expectedUpdatedAt` (409 `conflict` when the row is newer, row locked first); every change is audited
 * (`content.banner.*`, Hebrew-keyed, photo ids only) and clears the `content:` cache.
 */
@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
    private readonly storage: StorageProvider,
  ) {}

  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } finally {
      await this.cache.invalidate(CONTENT_CACHE_PREFIX);
    }
  }

  /** Newest first. */
  async list(): Promise<AdminBanner[]> {
    const rows = await this.prisma.banner.findMany({ orderBy: { id: 'desc' }, include: bannerImages });
    return rows.map((r) => this.view(r));
  }

  async get(id: number): Promise<AdminBanner> {
    const row = await this.prisma.banner.findUnique({ where: { id }, include: bannerImages });
    if (!row) throw notFound();
    return this.view(row);
  }

  async create(input: AdminBannerInput, meta: ContentMeta): Promise<AdminBanner> {
    return this.write(async (tx) => {
      await checkImages(tx, input);
      const row = await tx.banner.create({ data: bannerData(input), include: bannerImages });
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.banner.create',
        'banner',
        row.id,
        null,
        bannerAudit(row),
      );
      return this.view(row);
    });
  }

  async update(id: number, input: AdminBannerInput, expected: string, meta: ContentMeta): Promise<AdminBanner> {
    return this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM banners WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.banner.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      await checkImages(tx, input);
      const row = await tx.banner.update({ where: { id }, data: bannerData(input), include: bannerImages });
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.banner.update',
        'banner',
        id,
        bannerAudit(existing),
        bannerAudit(row),
      );
      return this.view(row);
    });
  }

  /**
   * Deletes the banner; its photos stay (nothing deletes photos in this phase). A banner a home section uses (hidden
   * sections too) is refused with 409 `banner_in_use` naming those sections. The row lock comes first: a home save
   * adding this banner reads it FOR SHARE, so either that save commits first and is seen here, or it waits and then
   * finds the banner gone.
   */
  async remove(id: number, meta: ContentMeta): Promise<void> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM banners WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.banner.findUnique({ where: { id } });
      if (!existing) throw notFound();
      const sections = await tx.homeSection.findMany({
        where: { kind: { in: [HomeSectionKind.HERO, HomeSectionKind.BANNER_PAIR] } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      const using = sections.filter((s) => bannerIdsOf(storedConfig(s)).includes(id));
      if (using.length) throw bannerInUse(using.map((s) => homeSectionName(s.titleHe, KIND[s.kind])));
      await tx.banner.delete({ where: { id } });
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.banner.delete',
        'banner',
        id,
        bannerAudit(existing),
        null,
      );
    });
  }

  private view(row: BannerWithImages): AdminBanner {
    return {
      id: row.id,
      nameHe: row.nameHe,
      headlineHe: row.headlineHe,
      sublineHe: row.sublineHe,
      ctaLabelHe: row.ctaLabelHe,
      linkUrl: row.linkUrl,
      imageId: row.imageId,
      image: contentImageRef(this.storage, row.image, row.altHe),
      mobileImageId: row.mobileImageId,
      mobileImage: row.mobileImage ? contentImageRef(this.storage, row.mobileImage, row.altHe) : null,
      altHe: row.altHe,
      active: row.active,
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Both photos must be content photos that exist (400 `invalid` on the field otherwise). */
async function checkImages(tx: Tx, input: AdminBannerInput): Promise<void> {
  const ids = input.mobileImageId === null ? [input.imageId] : [input.imageId, input.mobileImageId];
  const rows = await tx.contentImage.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const found = new Set(rows.map((i) => i.id));
  if (!found.has(input.imageId)) throw invalid('imageId');
  if (input.mobileImageId !== null && !found.has(input.mobileImageId)) throw invalid('mobileImageId');
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const yesNo = (b: boolean) => (b ? 'כן' : 'לא');

function bannerData(input: AdminBannerInput) {
  return {
    nameHe: input.nameHe,
    headlineHe: input.headlineHe,
    sublineHe: input.sublineHe,
    ctaLabelHe: input.ctaLabelHe,
    linkUrl: input.linkUrl,
    imageId: input.imageId,
    mobileImageId: input.mobileImageId,
    altHe: input.altHe,
    active: input.active,
    startsAt: input.startsAt === null ? null : new Date(input.startsAt),
    endsAt: input.endsAt === null ? null : new Date(input.endsAt),
  };
}

/** Readable and flat; photos by id only (never image data). */
function bannerAudit(row: Banner): AuditView {
  return {
    שם: row.nameHe,
    כותרת: row.headlineHe,
    'שורת משנה': row.sublineHe ?? '',
    'טקסט הכפתור': row.ctaLabelHe ?? '',
    קישור: row.linkUrl,
    תמונה: `#${row.imageId}`,
    'תמונה לנייד': row.mobileImageId === null ? '' : `#${row.mobileImageId}`,
    'טקסט חלופי': row.altHe,
    פעיל: yesNo(row.active),
    התחלה: iso(row.startsAt) ?? '',
    סיום: iso(row.endsAt) ?? '',
  };
}
