import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONTENT_LIMITS,
  CONTENT_SLUG_PATTERN,
  type AdminLandingPage,
  type AdminLandingPageInput,
  type AdminLandingPreview,
  type LandingEnded,
  type LandingPageView,
  type LandingResponse,
  type LandingState,
  type LandingUnavailable,
  type ProductSource,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import type { CatalogSnapshot } from '../catalog/catalog-snapshot.js';
import { CatalogService } from '../catalog/catalog.service.js';
import {
  LandingStatus as DbLandingStatus,
  Prisma,
  type ContentImage,
  type LandingPage,
} from '../generated/prisma/client.js';
import { StorageProvider } from '../media/storage.js';
import { resolveSiteUrl } from '../notifications/site-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PromotionsService } from '../promotions/promotions.service.js';
import type { AuditView } from '../shipping/shipping-audit.js';
import { recordContentChange, type ContentMeta } from './content-audit.js';
import { contentImageRef } from './content-image-ref.js';
import { conflict, invalid, notFound, slugTaken } from './content-errors.js';
import { CONTENT_CACHE_PREFIX, CONTENT_TTL_MS } from './content.service.js';
import { sourceText, storedSource } from './home/home-config.js';
import { checkProductSource } from './product-source-check.js';
import { productSourceLink, promotionUsable, resolveProductSource, type LivePromotion } from './product-source.js';
import { PreviewTokens, previewExpiry } from './preview-token.js';

type Tx = Prisma.TransactionClient;
type LandingRow = LandingPage & { image: ContentImage; mobileImage: ContentImage | null };

const LANDING_KEY = 'content:landing';
const withImages = { image: true, mobileImage: true } as const;

/** What `content:landing` keeps: the published pages by slug and the automatic promotions; dates are checked per request. */
interface LandingRows {
  pages: Map<string, LandingRow>;
  promotions: LivePromotion[];
}

const STATUS: Record<DbLandingStatus, AdminLandingPage['status']> = {
  [DbLandingStatus.DRAFT]: 'draft',
  [DbLandingStatus.PUBLISHED]: 'published',
};
const DB_STATUS: Record<AdminLandingPage['status'], DbLandingStatus> = {
  draft: DbLandingStatus.DRAFT,
  published: DbLandingStatus.PUBLISHED,
};

/** Where a page stands at `now` (admin lists; the public read uses the same rules). */
export function landingState(row: Pick<LandingPage, 'status' | 'startsAt' | 'endsAt'>, now: Date): LandingState {
  if (row.status !== DbLandingStatus.PUBLISHED) return 'draft';
  if (row.startsAt && now.getTime() < row.startsAt.getTime()) return 'scheduled';
  if (row.endsAt && now.getTime() > row.endsAt.getTime()) return 'ended';
  return 'live';
}

/** The 410 after a page's end: the title and where its button goes, nothing else. */
class LandingGone extends HttpException {
  constructor(body: LandingEnded) {
    super(body, HttpStatus.GONE);
  }
}

/**
 * Landing pages (Phase 8 §4.7, §9, MKT-02, decision 97): one fixed template at `/collection/:slug` with a product grid
 * from one source (`resolveProductSource`, up to 48 cards, cards from the catalog snapshot).
 *
 * Public: a published page inside its dates is `live`; a draft or a page before its start is a 404 `not_found` whose
 * body is the same as for an unknown slug; after the inclusive end, 410 with the title and the ended link. The published
 * rows and the automatic promotions sit in `content:landing` (60 s; every content save clears `content:`); the dates
 * are evaluated against `now` per request. With `?preview=<token>` a valid staff token (`PreviewTokens`, bound to the
 * page id) shows the page whatever its status or dates as `preview`, read straight from the database, never cached.
 *
 * Admin (content.manage): CRUD with `expectedUpdatedAt`, audited `content.landing.*` (photos by id, never a token);
 * `preview()` signs a token and returns the storefront address. Deleting a page keeps its photos; a photo a page uses
 * cannot be deleted (Restrict).
 */
@Injectable()
export class LandingService {
  private readonly site: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheStore,
    private readonly catalog: CatalogService,
    private readonly promotions: PromotionsService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
    @Inject(PreviewTokens) private readonly tokens: PreviewTokens,
    config: ConfigService,
  ) {
    this.site = resolveSiteUrl(config);
  }

  private rows(): Promise<LandingRows> {
    return this.cache.wrap(LANDING_KEY, CONTENT_TTL_MS, async () => {
      const [rows, promotions] = await Promise.all([
        this.prisma.landingPage.findMany({ where: { status: DbLandingStatus.PUBLISHED }, include: withImages }),
        this.promotions.automatic(this.prisma),
      ]);
      return { pages: new Map(rows.map((r) => [r.slug, r])), promotions };
    });
  }

  /**
   * `GET /api/content/landing/:slug[?preview=]`. A preview token that is missing, expired, of another page or tampered
   * with gives exactly the public answer.
   */
  async landing(slug: string, preview: string | undefined, now = new Date()): Promise<LandingResponse> {
    if (!slug || slug.length > CONTENT_LIMITS.slug || !CONTENT_SLUG_PATTERN.test(slug)) throw notFound();
    // The token names its page and is checked first; it must be the page at this slug.
    const previewId = preview ? this.tokens.pageOf(preview, now) : null;
    if (previewId !== null) {
      const row = await this.prisma.landingPage.findUnique({ where: { id: previewId }, include: withImages });
      if (row && row.slug === slug) {
        const [snapshot, promotions] = await Promise.all([
          this.catalog.snapshot(),
          this.promotions.automatic(this.prisma),
        ]);
        return { state: 'preview', page: this.pageView(row, snapshot, promotions, now) };
      }
    }
    const { pages, promotions } = await this.rows();
    const row = pages.get(slug);
    const state = row ? landingState(row, now) : 'draft';
    if (!row || state === 'draft' || state === 'scheduled') throw notFound();
    if (state === 'ended')
      throw new LandingGone({ state: 'ended', titleHe: row.titleHe, endedLinkUrl: row.endedLinkUrl });
    return { state: 'live', page: this.pageView(row, await this.catalog.snapshot(), promotions, now) };
  }

  private pageView(
    row: LandingRow,
    snapshot: CatalogSnapshot,
    promotions: LivePromotion[],
    now: Date,
  ): LandingPageView {
    const items = resolveProductSource(snapshot, storedSource(row.source), {
      limit: CONTENT_LIMITS.landingProducts,
      now,
      promotions,
    });
    const created = new Map(snapshot.products.map((p) => [p.id, p.createdAt.getTime()]));
    const newestOrder = items.map((c) => c.id).sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0) || a - b);
    return {
      slug: row.slug,
      titleHe: row.titleHe,
      sublineHe: row.sublineHe,
      introHtml: row.introHtml,
      outroHtml: row.outroHtml,
      image: contentImageRef(this.storage, row.image, row.altHe),
      mobileImage: row.mobileImage ? contentImageRef(this.storage, row.mobileImage, row.altHe) : null,
      altHe: row.altHe,
      items,
      newestOrder,
      metaDescriptionHe: row.metaDescriptionHe,
      noindex: row.noindex,
    };
  }

  // ---- Admin ----

  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } finally {
      await this.cache.invalidate(CONTENT_CACHE_PREFIX);
    }
  }

  /** Newest first, each with its state now and what the site cannot show of its source. */
  async list(now = new Date()): Promise<AdminLandingPage[]> {
    const rows = await this.prisma.landingPage.findMany({ orderBy: { id: 'desc' }, include: withImages });
    const [snapshot, promotions] = await Promise.all([this.catalog.snapshot(), this.promotions.automatic(this.prisma)]);
    return rows.map((r) => this.adminView(r, snapshot, promotions, now));
  }

  async get(id: number, now = new Date()): Promise<AdminLandingPage> {
    const row = await this.prisma.landingPage.findUnique({ where: { id }, include: withImages });
    if (!row) throw notFound();
    const [snapshot, promotions] = await Promise.all([this.catalog.snapshot(), this.promotions.automatic(this.prisma)]);
    return this.adminView(row, snapshot, promotions, now);
  }

  async create(input: AdminLandingPageInput, meta: ContentMeta): Promise<AdminLandingPage> {
    const id = await this.write(async (tx) => {
      await checkSlug(tx, input.slug, null);
      await checkImages(tx, input);
      await checkProductSource(tx, input.source, undefined, 'source');
      const row = await tx.landingPage.create({ data: landingData(input) }).catch(slugToTaken);
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.landing.create',
        'landing_page',
        row.id,
        null,
        landingAudit(row),
      );
      return row.id;
    });
    return this.get(id);
  }

  async update(
    id: number,
    input: AdminLandingPageInput,
    expected: string,
    meta: ContentMeta,
  ): Promise<AdminLandingPage> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM landing_pages WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.landingPage.findUnique({ where: { id } });
      if (!existing) throw notFound();
      if (existing.updatedAt.toISOString() !== expected) throw conflict();
      await checkSlug(tx, input.slug, id);
      await checkImages(tx, input);
      await checkProductSource(tx, input.source, storedSource(existing.source), 'source');
      const row = await tx.landingPage.update({ where: { id }, data: landingData(input) }).catch(slugToTaken);
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.landing.update',
        'landing_page',
        id,
        landingAudit(existing),
        landingAudit(row),
      );
    });
    return this.get(id);
  }

  /** Deletes the page; its photos stay (nothing deletes photos in this phase). */
  async remove(id: number, meta: ContentMeta): Promise<void> {
    await this.write(async (tx) => {
      await tx.$queryRaw`SELECT id FROM landing_pages WHERE id = ${id} FOR UPDATE`;
      const existing = await tx.landingPage.findUnique({ where: { id } });
      if (!existing) throw notFound();
      await tx.landingPage.delete({ where: { id } });
      await recordContentChange(
        this.audit,
        tx,
        meta,
        'content.landing.delete',
        'landing_page',
        id,
        landingAudit(existing),
        null,
      );
    });
  }

  /**
   * A signed preview address for staff (30 minutes, this page only), whatever the page's status. Audited
   * `content.landing.preview` with the page address and the expiry — never the token.
   */
  async preview(id: number, meta: ContentMeta, now = new Date()): Promise<AdminLandingPreview> {
    const row = await this.prisma.landingPage.findUnique({ where: { id }, select: { id: true, slug: true } });
    if (!row) throw notFound();
    const token = this.tokens.sign(row.id, now);
    const expiresAt = previewExpiry(now).toISOString();
    await this.prisma.$transaction((tx) =>
      recordContentChange(this.audit, tx, meta, 'content.landing.preview', 'landing_page', row.id, null, {
        כתובת: `/collection/${row.slug}`,
        'בתוקף עד': expiresAt,
      }),
    );
    return { url: `${this.site}/collection/${row.slug}?preview=${encodeURIComponent(token)}`, expiresAt };
  }

  private adminView(
    row: LandingRow,
    snapshot: CatalogSnapshot,
    promotions: LivePromotion[],
    now: Date,
  ): AdminLandingPage {
    const source = storedSource(row.source);
    return {
      id: row.id,
      slug: row.slug,
      titleHe: row.titleHe,
      sublineHe: row.sublineHe,
      introHtml: row.introHtml,
      outroHtml: row.outroHtml,
      imageId: row.imageId,
      image: contentImageRef(this.storage, row.image, row.altHe),
      mobileImageId: row.mobileImageId,
      mobileImage: row.mobileImage ? contentImageRef(this.storage, row.mobileImage, row.altHe) : null,
      altHe: row.altHe,
      source,
      status: STATUS[row.status],
      state: landingState(row, now),
      startsAt: iso(row.startsAt),
      endsAt: iso(row.endsAt),
      endedLinkUrl: row.endedLinkUrl,
      metaDescriptionHe: row.metaDescriptionHe,
      noindex: row.noindex,
      unavailable: unavailableOf(source, snapshot, promotions, now),
      sourceLink: productSourceLink(snapshot, source),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function unavailableOf(
  source: ProductSource,
  snapshot: CatalogSnapshot,
  promotions: LivePromotion[],
  now: Date,
): LandingUnavailable {
  const result: LandingUnavailable = { productIds: [], source: false };
  if (source.kind === 'manual') {
    const shown = new Set(snapshot.products.map((p) => p.id));
    result.productIds = source.productIds.filter((id) => !shown.has(id));
  } else if (source.kind === 'category' || source.kind === 'room') {
    result.source = productSourceLink(snapshot, source) === null;
  } else if (source.kind === 'promotion') {
    const promotion = promotions.find((p) => p.id === source.id);
    result.source = !promotion || !promotionUsable(promotion, now);
  }
  return result;
}

async function checkSlug(tx: Tx, slug: string, id: number | null): Promise<void> {
  const other = await tx.landingPage.findUnique({ where: { slug }, select: { id: true } });
  if (other && other.id !== id) throw slugTaken();
}

function slugToTaken(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw slugTaken();
  throw e;
}

/** Both photos must be content photos that exist (400 `invalid` on the field otherwise). */
async function checkImages(tx: Tx, input: AdminLandingPageInput): Promise<void> {
  const ids = input.mobileImageId === null ? [input.imageId] : [input.imageId, input.mobileImageId];
  const rows = await tx.contentImage.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const found = new Set(rows.map((i) => i.id));
  if (!found.has(input.imageId)) throw invalid('imageId');
  if (input.mobileImageId !== null && !found.has(input.mobileImageId)) throw invalid('mobileImageId');
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const yesNo = (b: boolean) => (b ? 'כן' : 'לא');

function landingData(input: AdminLandingPageInput) {
  return {
    slug: input.slug,
    titleHe: input.titleHe,
    sublineHe: input.sublineHe,
    introHtml: input.introHtml,
    outroHtml: input.outroHtml,
    imageId: input.imageId,
    mobileImageId: input.mobileImageId,
    altHe: input.altHe,
    source: input.source as Prisma.InputJsonObject,
    status: DB_STATUS[input.status],
    startsAt: input.startsAt === null ? null : new Date(input.startsAt),
    endsAt: input.endsAt === null ? null : new Date(input.endsAt),
    endedLinkUrl: input.endedLinkUrl ?? '/',
    metaDescriptionHe: input.metaDescriptionHe,
    noindex: input.noindex,
  };
}

/** Readable and flat; photos by id only (never image data). */
function landingAudit(row: LandingPage): AuditView {
  return {
    כותרת: row.titleHe,
    כתובת: `/collection/${row.slug}`,
    'שורת משנה': row.sublineHe ?? '',
    'טקסט פתיחה': row.introHtml,
    'טקסט סיום': row.outroHtml ?? '',
    תמונה: `#${row.imageId}`,
    'תמונה לנייד': row.mobileImageId === null ? '' : `#${row.mobileImageId}`,
    'טקסט חלופי': row.altHe,
    מוצרים: sourceText(storedSource(row.source)),
    מפורסם: yesNo(row.status === DbLandingStatus.PUBLISHED),
    התחלה: iso(row.startsAt) ?? '',
    סיום: iso(row.endsAt) ?? '',
    'קישור אחרי הסיום': row.endedLinkUrl,
    'תיאור לגוגל': row.metaDescriptionHe ?? '',
    'ללא אינדוקס': yesNo(row.noindex),
  };
}
