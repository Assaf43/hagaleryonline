import { Injectable } from '@nestjs/common';
import type {
  AdminHome,
  AdminHomeSection,
  AdminHomeSectionInput,
  BannerView,
  HomeHeroFallback,
  HomeRoom,
  HomeSectionConfig,
  HomeSectionUnavailable,
  HomeSectionView,
  HomeView,
  ProductSource,
} from '@hg/models';
import { AuditService } from '../../audit/audit.service.js';
import { CacheStore } from '../../cache/cache-store.js';
import type { CatalogSnapshot } from '../../catalog/catalog-snapshot.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import {
  PromotionKind as DbPromotionKind,
  PromotionTarget as DbPromotionTarget,
  type HomeSection,
  type Prisma,
} from '../../generated/prisma/client.js';
import { StorageProvider } from '../../media/storage.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PromotionsService } from '../../promotions/promotions.service.js';
import { recordContentChange, type ContentMeta } from '../content-audit.js';
import { conflict, invalid, invalidSource } from '../content-errors.js';
import { bannerImages, bannerView } from '../content-image-ref.js';
import { isLive, type Windowed } from '../content-window.js';
import { CONTENT_CACHE_PREFIX, CONTENT_TTL_MS } from '../content.service.js';
import {
  categoryTile,
  productSourceLink,
  promotionUsable,
  resolveProductSource,
  type LivePromotion,
} from '../product-source.js';
import { DB_KIND, bannerIdsOf, configJson, homeAudit, storedConfig } from './home-config.js';

type Tx = Prisma.TransactionClient;
const HOME_KEY = 'content:home';

/** A section as stored, with its kind and settings read (`storedConfig`). */
interface Section {
  id: number;
  titleHe: string | null;
  visible: boolean;
  config: HomeSectionConfig;
  updatedAt: Date;
}

/** A banner ready for the site, with its window (evaluated per request). */
interface CachedBanner extends Windowed {
  view: BannerView;
}

/** What `content:home` keeps: the rows only; date windows and product cards are worked out per request. */
interface HomeRows {
  sections: Section[];
  banners: Map<number, CachedBanner>;
  promotions: LivePromotion[];
}

const toSection = (row: HomeSection): Section => ({
  id: row.id,
  titleHe: row.titleHe,
  visible: row.visible,
  config: storedConfig(row),
  updatedAt: row.updatedAt,
});

/**
 * The managed home page (Phase 8 §4.6, §9, NAV-05, decision 98). Public: `home()` resolves the visible sections in one
 * call — banners live now, product rows and tile photos from the catalog snapshot (so cards follow the catalog's own
 * 60-second refresh), the static hero when no banner is live. The section, banner and promotion rows sit in the cache
 * under `content:home` (60 s; every content save clears `content:`); windows are evaluated against `now` per request.
 * Admin: the whole list is read and saved at once (`expectedUpdatedAt` = the newest section's `updatedAt`), audited as
 * `content.home.update`.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheStore,
    private readonly catalog: CatalogService,
    private readonly promotions: PromotionsService,
    private readonly storage: StorageProvider,
    private readonly audit: AuditService,
  ) {}

  private rows(): Promise<HomeRows> {
    return this.cache.wrap(HOME_KEY, CONTENT_TTL_MS, () => this.loadRows());
  }

  private async loadRows(): Promise<HomeRows> {
    const rows = await this.prisma.homeSection.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const sections = rows.map(toSection);
    const bannerIds = [...new Set(sections.flatMap((s) => bannerIdsOf(s.config)))];
    const [bannerRows, promotions] = await Promise.all([
      this.prisma.banner.findMany({ where: { id: { in: bannerIds } }, include: bannerImages }),
      // The automatic promotions with their uses: the read the cart prices with.
      this.promotions.automatic(this.prisma),
    ]);
    const banners = new Map(
      bannerRows.map((b) => [
        b.id,
        { view: bannerView(this.storage, b), active: b.active, startsAt: b.startsAt, endsAt: b.endsAt },
      ]),
    );
    return { sections, banners, promotions };
  }

  /** `GET /api/content/home`: the visible sections that have something to show, resolved. */
  async home(now = new Date()): Promise<HomeView> {
    const [rows, snapshot] = await Promise.all([this.rows(), this.catalog.snapshot()]);
    const visible = rows.sections.filter((s) => s.visible);
    const needsMenu = visible.some((s) => s.config.kind === 'hero' || s.config.kind === 'rooms');
    const [rooms, categories] = needsMenu
      ? await Promise.all([this.catalog.rooms(), this.catalog.categories()])
      : [[], []];
    const live = (ids: number[]) =>
      ids
        .map((id) => rows.banners.get(id))
        .filter((b) => b !== undefined && isLive(b, now))
        .map((b) => b!.view);

    const sections: HomeSectionView[] = [];
    for (const { id, titleHe, config } of visible) {
      switch (config.kind) {
        case 'hero': {
          const fallback: HomeHeroFallback = {
            image:
              resolveProductSource(snapshot, { kind: 'bestsellers' }, { limit: 1, now, promotions: [] })[0]?.image ??
              null,
            category: categories[0] ? { slug: categories[0].slug, nameHe: categories[0].nameHe } : null,
            room: rooms[0] ? { slug: rooms[0].slug, nameHe: rooms[0].nameHe } : null,
          };
          sections.push({ id, titleHe, kind: 'hero', banner: live(config.bannerIds)[0] ?? null, fallback });
          break;
        }
        case 'trust':
          sections.push({ id, titleHe, kind: 'trust' });
          break;
        case 'rooms': {
          const withTiles: HomeRoom[] = rooms.map((room) => ({
            slug: room.slug,
            nameHe: room.nameHe,
            categories: room.categories.map((c) => {
              const tileId = snapshot.categories.get(c.slug)?.id;
              const tile = tileId === undefined ? null : categoryTile(snapshot, tileId, now);
              return { slug: c.slug, nameHe: c.nameHe, image: tile?.image ?? null };
            }),
          }));
          if (withTiles.length) sections.push({ id, titleHe, kind: 'rooms', rooms: withTiles });
          break;
        }
        case 'categories': {
          const tiles = config.categoryIds.map((c) => categoryTile(snapshot, c, now)).filter((t) => t !== null);
          if (tiles.length) sections.push({ id, titleHe, kind: 'categories', categories: tiles });
          break;
        }
        case 'products': {
          const items = resolveProductSource(snapshot, config.source, {
            limit: config.count,
            now,
            promotions: rows.promotions,
          });
          if (items.length)
            sections.push({ id, titleHe, kind: 'products', items, link: productSourceLink(snapshot, config.source) });
          break;
        }
        case 'banner_pair': {
          const banners = live(config.bannerIds).slice(0, 2);
          if (banners.length) sections.push({ id, titleHe, kind: 'banner_pair', banners });
          break;
        }
      }
    }
    return { sections };
  }

  // ---- Admin ----

  /** Every section in order, with what the site cannot show of each now. */
  async adminHome(now = new Date()): Promise<AdminHome> {
    const rows = await this.prisma.homeSection.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const sections = rows.map(toSection);
    const bannerIds = [...new Set(sections.flatMap((s) => bannerIdsOf(s.config)))];
    const [snapshot, banners, promotions] = await Promise.all([
      this.catalog.snapshot(),
      this.prisma.banner.findMany({ where: { id: { in: bannerIds } } }),
      this.promotions.automatic(this.prisma),
    ]);
    const bannerById = new Map(banners.map((b) => [b.id, b]));
    return {
      sections: sections.map((s): AdminHomeSection => ({
        ...s.config,
        id: s.id,
        titleHe: s.titleHe,
        visible: s.visible,
        unavailable: unavailableOf(
          s.config,
          snapshot,
          (id) => {
            const banner = bannerById.get(id);
            return banner !== undefined && isLive(banner, now);
          },
          promotions,
          now,
        ),
      })),
      updatedAt: newest(sections)?.toISOString() ?? new Date(0).toISOString(),
    };
  }

  /**
   * Saves the whole list in page order: sections sent with an id are updated, new ones created, the rest removed.
   * 409 `conflict` when a section was saved after `expected` (the newest `updatedAt` the editor started from). Every
   * reference must exist (400 `invalid` on its field) unless the same section already holds it (a reference that went
   * away later never blocks a save; the admin marks it); a promotion source must be automatic, on categories or products
   * and not members-only (400 `invalid_source`), an ended or inactive one is accepted (the section just hides).
   */
  async saveHome(input: AdminHomeSectionInput[], expected: string, meta: ContentMeta): Promise<AdminHome> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // One save at a time; readers are not blocked.
        await tx.$executeRaw`LOCK TABLE home_sections IN EXCLUSIVE MODE`;
        const existing = (await tx.homeSection.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map(
          toSection,
        );
        const stamp = newest(existing);
        if (stamp && stamp.toISOString() !== expected) throw conflict();
        const byId = new Map(existing.map((s) => [s.id, s]));
        input.forEach((s, i) => {
          if (s.id !== undefined && !byId.has(s.id)) throw invalid(`sections.${i}.id`);
        });
        await checkReferences(tx, input, existing);

        const keep = new Set(input.map((s) => s.id).filter((id) => id !== undefined));
        await tx.homeSection.deleteMany({ where: { id: { notIn: [...keep] } } });
        for (const [sortOrder, s] of input.entries()) {
          const data = {
            sortOrder,
            kind: DB_KIND[s.kind],
            titleHe: s.titleHe,
            visible: s.visible,
            config: configJson(s),
          };
          if (s.id === undefined) await tx.homeSection.create({ data });
          else await tx.homeSection.update({ where: { id: s.id }, data });
        }
        const after = input.map((s) => ({ titleHe: s.titleHe, visible: s.visible, config: sectionConfig(s) }));
        await recordContentChange(
          this.audit,
          tx,
          meta,
          'content.home.update',
          'home_page',
          1,
          homeAudit(existing),
          homeAudit(after),
        );
      });
    } finally {
      await this.cache.invalidate(CONTENT_CACHE_PREFIX);
    }
    return this.adminHome();
  }
}

/** The kind and settings of an input section (without its id, title and switch). */
function sectionConfig(s: AdminHomeSectionInput): HomeSectionConfig {
  return storedConfig({ kind: DB_KIND[s.kind], config: configJson(s) });
}

function newest(sections: { updatedAt: Date }[]): Date | null {
  let max: Date | null = null;
  for (const s of sections) if (!max || s.updatedAt > max) max = s.updatedAt;
  return max;
}

function unavailableOf(
  config: HomeSectionConfig,
  snapshot: CatalogSnapshot,
  bannerLive: (id: number) => boolean,
  promotions: LivePromotion[],
  now: Date,
): HomeSectionUnavailable {
  const result: HomeSectionUnavailable = { bannerIds: [], categoryIds: [], productIds: [], source: false };
  result.bannerIds = bannerIdsOf(config).filter((id) => !bannerLive(id));
  if (config.kind === 'categories')
    result.categoryIds = config.categoryIds.filter((id) => categoryTile(snapshot, id, now) === null);
  if (config.kind === 'products') {
    const { source } = config;
    if (source.kind === 'manual') {
      const shown = new Set(snapshot.products.map((p) => p.id));
      result.productIds = source.productIds.filter((id) => !shown.has(id));
    } else if (source.kind === 'category' || source.kind === 'room') {
      result.source = productSourceLink(snapshot, source) === null;
    } else if (source.kind === 'promotion') {
      const promotion = promotions.find((p) => p.id === source.id);
      result.source = !promotion || !promotionUsable(promotion, now);
    }
  }
  return result;
}

const sameSource = (a: ProductSource, b: ProductSource) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Every new reference must exist: banners (read FOR SHARE, so a banner delete waits for this save and then sees the
 * section using it, or this save waits for the delete and finds the banner gone), categories, rooms, products and
 * promotions. A reference the same section already holds is accepted as it is.
 */
async function checkReferences(tx: Tx, input: AdminHomeSectionInput[], existing: Section[]): Promise<void> {
  const stored = new Map(existing.map((s) => [s.id, s.config]));
  const held = (i: number, pick: (c: HomeSectionConfig) => number[]) => {
    const id = input[i].id;
    const config = id === undefined ? undefined : stored.get(id);
    return new Set(config ? pick(config) : []);
  };

  const wantedBanners = [...new Set(input.flatMap(bannerIdsOf))];
  const banners = wantedBanners.length
    ? await tx.$queryRaw<{ id: number }[]>`SELECT id FROM banners WHERE id = ANY(${wantedBanners}::int[]) FOR SHARE`
    : [];
  const categoryIds = input.flatMap((s) =>
    s.kind === 'categories'
      ? s.categoryIds
      : s.kind === 'products' && s.source.kind === 'category'
        ? [s.source.id]
        : [],
  );
  const roomIds = input.flatMap((s) => (s.kind === 'products' && s.source.kind === 'room' ? [s.source.id] : []));
  const productIds = input.flatMap((s) =>
    s.kind === 'products' && s.source.kind === 'manual' ? s.source.productIds : [],
  );
  const promotionIds = input.flatMap((s) =>
    s.kind === 'products' && s.source.kind === 'promotion' ? [s.source.id] : [],
  );
  const [categories, rooms, products, promotions] = await Promise.all([
    tx.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true } }),
    tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true } }),
    tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true } }),
    tx.promotion.findMany({
      where: { id: { in: promotionIds } },
      select: { id: true, kind: true, target: true, membersOnly: true },
    }),
  ]);
  const has = (rows: { id: number }[]) => new Set(rows.map((r) => r.id));
  const [bannerSet, categorySet, roomSet, productSet] = [has(banners), has(categories), has(rooms), has(products)];
  const promotionById = new Map(promotions.map((p) => [p.id, p]));

  input.forEach((s, i) => {
    const field = (key: string) => `sections.${i}.${key}`;
    const heldBanners = held(i, bannerIdsOf);
    if (bannerIdsOf(s).some((id) => !bannerSet.has(id) && !heldBanners.has(id))) throw invalid(field('bannerIds'));
    if (s.kind === 'categories') {
      const heldCategories = held(i, (c) => (c.kind === 'categories' ? c.categoryIds : []));
      if (s.categoryIds.some((id) => !categorySet.has(id) && !heldCategories.has(id)))
        throw invalid(field('categoryIds'));
    }
    if (s.kind !== 'products') return;
    const { source } = s;
    const before = s.id === undefined ? undefined : stored.get(s.id);
    const unchanged = before?.kind === 'products' && sameSource(before.source, source);
    if (source.kind === 'manual') {
      const heldProducts = held(i, (c) =>
        c.kind === 'products' && c.source.kind === 'manual' ? c.source.productIds : [],
      );
      if (source.productIds.some((id) => !productSet.has(id) && !heldProducts.has(id)))
        throw invalid(field('source.productIds'));
    }
    if (unchanged) return;
    if (source.kind === 'category' && !categorySet.has(source.id)) throw invalid(field('source.id'));
    if (source.kind === 'room' && !roomSet.has(source.id)) throw invalid(field('source.id'));
    if (source.kind === 'promotion') {
      const promotion = promotionById.get(source.id);
      if (
        !promotion ||
        promotion.kind !== DbPromotionKind.AUTOMATIC ||
        promotion.target === DbPromotionTarget.ORDER ||
        promotion.membersOnly
      )
        throw invalidSource(field('source'));
    }
  });
}
