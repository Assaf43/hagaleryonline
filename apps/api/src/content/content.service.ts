import { Injectable } from '@nestjs/common';
import type { AnnouncementView, FaqView, InfoPageView, SiteContentView, SitemapData } from '@hg/models';
import { CacheStore } from '../cache/cache-store.js';
import type { Announcement, FaqGroup, FaqItem, InfoPage, SiteContent } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentAnnouncement } from './content-window.js';
import { notFound } from './content-errors.js';

/** Content rows TTL (Phase 8 §6); every admin save also clears the `content:` prefix right away. */
export const CONTENT_TTL_MS = 60_000;
export const CONTENT_CACHE_PREFIX = 'content:';
const ALL_KEY = 'content:all';

/** Every row the public content endpoints read, loaded in one go and cached; date windows are applied per request. */
interface ContentRows {
  site: SiteContent | null;
  /** Active announcements only (an inactive one never shows). */
  announcements: Announcement[];
  /** Published pages only, in footer order. */
  pages: InfoPage[];
  /** Published groups with their published items, in order. */
  faq: (FaqGroup & { items: FaqItem[] })[];
}

/**
 * Public content reads (NAV-04, SRV-04): site details with the current announcement and the footer pages, info pages
 * and the FAQ. The rows sit in the in-memory cache (`content:all`, 60 s) like the catalog snapshot; the announcement
 * window is evaluated against `now` on every request, so a cached row starts and ends on time.
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheStore,
  ) {}

  private rows(): Promise<ContentRows> {
    return this.cache.wrap(ALL_KEY, CONTENT_TTL_MS, async () => {
      const [site, announcements, pages, faq] = await Promise.all([
        this.prisma.siteContent.findUnique({ where: { id: 1 } }),
        this.prisma.announcement.findMany({ where: { active: true } }),
        this.prisma.infoPage.findMany({ where: { published: true }, orderBy: [{ footerOrder: 'asc' }, { id: 'asc' }] }),
        this.prisma.faqGroup.findMany({
          where: { published: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: { items: { where: { published: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
        }),
      ]);
      return { site, announcements, pages, faq };
    });
  }

  async site(now = new Date()): Promise<SiteContentView> {
    const { site, announcements, pages } = await this.rows();
    // The row is created by the migration; a missing row would be a broken database, not an empty site.
    if (!site) throw notFound();
    const current = currentAnnouncement(announcements, now);
    return {
      supportPhone: site.supportPhone,
      supportEmail: site.supportEmail,
      whatsapp: site.whatsapp,
      shippingHtml: site.shippingHtml,
      announcement: current ? announcementView(current) : null,
      footerPages: pages
        .filter((p) => p.showInFooter)
        .map((p) => ({ slug: p.slug, labelHe: p.footerLabelHe ?? p.titleHe })),
    };
  }

  /** A published page; unknown or unpublished → 404 `not_found`. */
  async page(slug: string): Promise<InfoPageView> {
    const page = (await this.rows()).pages.find((p) => p.slug === slug);
    if (!page) throw notFound();
    return {
      slug: page.slug,
      titleHe: page.titleHe,
      bodyHtml: page.bodyHtml,
      metaDescriptionHe: page.metaDescriptionHe,
      noindex: page.noindex,
      updatedAt: page.updatedAt.toISOString(),
    };
  }

  async faq(): Promise<FaqView> {
    const { faq } = await this.rows();
    return {
      groups: faq
        .filter((g) => g.items.length > 0)
        .map((g) => ({
          titleHe: g.titleHe,
          items: g.items.map((i) => ({ questionHe: i.questionHe, answerHtml: i.answerHtml })),
        })),
    };
  }

  /** Info pages for sitemap.xml (Phase 8 §9): published and not noindex. */
  async sitemapPages(): Promise<SitemapData['infoPages']> {
    return (await this.rows()).pages
      .filter((p) => !p.noindex)
      .map((p) => ({ slug: p.slug, updatedAt: p.updatedAt.toISOString() }));
  }
}

function announcementView(a: Announcement): AnnouncementView {
  return { id: a.id, version: a.version, textHe: a.textHe, linkUrl: a.linkUrl, linkLabelHe: a.linkLabelHe };
}
