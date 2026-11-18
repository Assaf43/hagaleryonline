/**
 * Content management (Phase 8, spec specs/2026-11-17-phase-8-cms-design.md, decisions 97–101): the announcement bar,
 * info pages, FAQ and site details (8a). Rich-text fields hold HTML already sanitized by the API
 * (`sanitizeContentHtml`): `page` mode (h2, h3) for info pages, `inline` mode (no headings) for the shipping text and
 * FAQ answers. Dates are ISO strings; an `endsAt` is inclusive (23:59:59.999 of the Israel day).
 * 8b adds content images, banners and the managed home page (NAV-05, decision 98).
 */
import type { ImageRef, ProductCard } from './catalog.js';

/** Length limits (characters, after trimming). */
export const CONTENT_LIMITS = {
  announcementText: 120,
  title: 120,
  metaDescription: 160,
  /** Rich-text HTML, after sanitizing. */
  body: 50_000,
  faqQuestion: 200,
  /** The announcement link label and an info page's footer label. */
  linkLabel: 40,
  /** An info page slug (`CONTENT_SLUG_PATTERN`). */
  slug: 80,
  /** Items in one FAQ group. */
  faqItems: 100,
  /** A banner's internal name (admin lists only). */
  bannerName: 80,
  bannerHeadline: 80,
  bannerSubline: 160,
  /** A banner's button label. */
  bannerCta: 30,
  /** A banner's image alt text. */
  bannerAlt: 160,
  /** Sections on the home page. */
  homeSections: 20,
  /** Banners of a hero section (the first live one shows). */
  heroBanners: 5,
  /** Banners of a banner pair (the first two live ones show). */
  pairBanners: 4,
  /** Category tiles of a categories section. */
  categoryTilesMin: 2,
  categoryTilesMax: 8,
  /** Products picked by hand (a manual product source). */
  manualProducts: 48,
} as const;

/**
 * Content photo uploads (banners, landing pages; Phase 8 §6): JPG, PNG or WebP up to 15MB, at least 1200px on the
 * long side, made in four widths (2400 for full-width heroes on large screens).
 */
export const CONTENT_IMAGE = {
  widths: [480, 960, 1600, 2400],
  minLongSide: 1200,
  maxBytes: 15 * 1024 * 1024,
  types: ['image/jpeg', 'image/png', 'image/webp'],
} as const;

/** An info page slug: lower-case English letters and digits, words joined by single dashes. */
export const CONTENT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Admin content errors (`code` + optional `field`), mapped to Hebrew by the admin's `core/errors.ts`:
 * `conflict` (someone saved the row after it was opened), `invalid` (bad or missing field; an image upload names the
 * problem in `value`, an `ImageUploadProblem`), `invalid_link` (a link field that is not https, mailto, tel or a site
 * path), `slug_taken`, `system_page` (a system page cannot be deleted, renamed or unpublished), `banner_in_use` (a
 * banner a home section uses cannot be deleted; `sections` names them), `invalid_source` (a product source naming a
 * promotion that is not automatic, gives its discount on the whole order or is for members only), `not_found`.
 */
export type ContentErrorCode =
  | 'conflict'
  | 'invalid'
  | 'invalid_link'
  | 'slug_taken'
  | 'system_page'
  | 'banner_in_use'
  | 'invalid_source'
  | 'not_found';

/** The announcement bar message shown now (at most one). The `hg-ann` cookie holds `id:version` of a closed bar. */
export interface AnnouncementView {
  id: number;
  version: number;
  textHe: string;
  linkUrl: string | null;
  linkLabelHe: string | null;
}

/** A published info page marked "show in footer", in footer order. */
export interface FooterLink {
  slug: string;
  labelHe: string;
}

/** `GET /api/content/site`: site details, the current announcement and the footer info pages. */
export interface SiteContentView {
  supportPhone: string;
  supportEmail: string;
  /** Digits only, international form without "+". */
  whatsapp: string;
  /** Inline rich text (product-page shipping text). */
  shippingHtml: string;
  announcement: AnnouncementView | null;
  footerPages: FooterLink[];
}

/** `GET /api/content/pages/:slug`: a published info page. */
export interface InfoPageView {
  slug: string;
  titleHe: string;
  /** Page rich text. */
  bodyHtml: string;
  metaDescriptionHe: string | null;
  noindex: boolean;
  updatedAt: string;
}

/** `GET /api/content/faq`: published groups with their published items, in order. */
export interface FaqView {
  groups: {
    titleHe: string;
    items: {
      questionHe: string;
      /** Inline rich text. */
      answerHtml: string;
    }[];
  }[];
}

// ---- Admin (content.manage). Every save sends the `updatedAt` it started from as `expectedUpdatedAt`. ----

export interface AdminSiteContent {
  supportPhone: string;
  supportEmail: string;
  whatsapp: string;
  shippingHtml: string;
  /** Seeded interim values not yet saved by an editor ("טקסט זמני"). */
  interim: boolean;
  updatedAt: string;
}

export interface AdminAnnouncement {
  id: number;
  textHe: string;
  linkUrl: string | null;
  linkLabelHe: string | null;
  active: boolean;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminInfoPage {
  id: number;
  slug: string;
  /** Set for the system pages (terms, privacy, shipping, returns, warranty): no delete, fixed slug, always published. */
  systemKey: string | null;
  titleHe: string;
  bodyHtml: string;
  metaDescriptionHe: string | null;
  published: boolean;
  noindex: boolean;
  showInFooter: boolean;
  footerLabelHe: string | null;
  footerOrder: number;
  /** Seeded interim text not yet saved by an editor ("טקסט זמני"). */
  interim: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminFaqItem {
  id: number;
  questionHe: string;
  answerHtml: string;
  sortOrder: number;
  published: boolean;
}

/** A FAQ group with its items, saved as a whole. */
export interface AdminFaqGroup {
  id: number;
  titleHe: string;
  sortOrder: number;
  published: boolean;
  items: AdminFaqItem[];
  updatedAt: string;
}

// ---- Admin inputs. `expectedUpdatedAt` is required on every update (PUT) and ignored on create. ----

export interface AdminSiteContentInput {
  supportPhone: string;
  supportEmail: string;
  whatsapp: string;
  shippingHtml: string;
  expectedUpdatedAt?: string;
}

export interface AdminAnnouncementInput {
  textHe: string;
  linkUrl: string | null;
  linkLabelHe: string | null;
  active: boolean;
  sortOrder: number;
  /** ISO times; the admin sends the start of the first Israel day and 23:59:59.999 of the last. */
  startsAt: string | null;
  endsAt: string | null;
  expectedUpdatedAt?: string;
}

export interface AdminInfoPageInput {
  slug: string;
  titleHe: string;
  bodyHtml: string;
  metaDescriptionHe: string | null;
  published: boolean;
  noindex: boolean;
  showInFooter: boolean;
  footerLabelHe: string | null;
  footerOrder: number;
  expectedUpdatedAt?: string;
}

export interface AdminFaqItemInput {
  /** An existing item of this group; left out for a new item. Items not sent are deleted. */
  id?: number;
  questionHe: string;
  answerHtml: string;
  published: boolean;
}

/** A FAQ group with all its items, in order (the item order is the array order). */
export interface AdminFaqGroupInput {
  titleHe: string;
  sortOrder: number;
  published: boolean;
  items: AdminFaqItemInput[];
  expectedUpdatedAt?: string;
}

// ---- Content images and banners (8b, NAV-05) ----

/** `POST /api/admin/content/images` (multipart `file`): the stored photo. `image.altHe` is empty (alt text lives on
 * the row that uses the photo). */
export interface AdminContentImage {
  id: number;
  image: ImageRef;
}

/** A live banner as the site shows it. `mobileImage` null = the desktop image on every screen. */
export interface BannerView {
  id: number;
  headlineHe: string;
  sublineHe: string | null;
  ctaLabelHe: string | null;
  linkUrl: string;
  /** `altHe` of both images is the banner's alt text. */
  image: ImageRef;
  mobileImage: ImageRef | null;
  altHe: string;
}

export interface AdminBanner {
  id: number;
  /** Internal name, shown only in the admin. */
  nameHe: string;
  headlineHe: string;
  sublineHe: string | null;
  ctaLabelHe: string | null;
  linkUrl: string;
  imageId: number;
  image: ImageRef;
  mobileImageId: number | null;
  mobileImage: ImageRef | null;
  altHe: string;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBannerInput {
  nameHe: string;
  headlineHe: string;
  sublineHe: string | null;
  ctaLabelHe: string | null;
  /** Required: https, mailto, tel or a site path (else `invalid_link`). */
  linkUrl: string;
  /** A content image (`POST /api/admin/content/images`). */
  imageId: number;
  mobileImageId: number | null;
  altHe: string;
  active: boolean;
  /** ISO times; the admin sends the start of the first Israel day and 23:59:59.999 of the last. */
  startsAt: string | null;
  endsAt: string | null;
  expectedUpdatedAt?: string;
}

// ---- Managed home page (8b, NAV-05, decision 98) ----

/**
 * Where a product row or grid gets its products (home sections and landing pages): best sellers, newest, a category
 * (its sub-categories included) or a room in the default listing order, the products a promotion targets (only a live
 * automatic promotion on categories or products that is not members-only; anything else gives nothing), or products
 * picked by hand, in their order. Only products shown on the site appear; a missing reference drops silently.
 */
export type ProductSource =
  | { kind: 'bestsellers' | 'newest' }
  | { kind: 'category' | 'room' | 'promotion'; id: number }
  | { kind: 'manual'; productIds: number[] };

export type HomeSectionKind = 'hero' | 'trust' | 'rooms' | 'categories' | 'products' | 'banner_pair';

/** Hebrew names of the section kinds (admin screen, audit entries, `banner_in_use`). */
export const HOME_SECTION_LABELS_HE: Record<HomeSectionKind, string> = {
  hero: 'באנר ראשי',
  trust: 'שורת יתרונות',
  rooms: 'חדרים וסוגי רהיטים',
  categories: 'אריחי קטגוריות',
  products: 'שורת מוצרים',
  banner_pair: 'זוג באנרים',
};

/** Products in a product row. */
export const HOME_PRODUCT_COUNTS = [4, 8, 12] as const;
export type HomeProductCount = (typeof HOME_PRODUCT_COUNTS)[number];

/** A section's kind with its settings (the settings are `home_sections.config`). */
export type HomeSectionConfig =
  | { kind: 'hero'; bannerIds: number[] }
  | { kind: 'trust' }
  | { kind: 'rooms' }
  | { kind: 'categories'; categoryIds: number[] }
  | { kind: 'products'; source: ProductSource; count: HomeProductCount }
  | { kind: 'banner_pair'; bannerIds: number[] };

/** A link of the static hero or a tile: an English slug and the Hebrew name. */
export interface HomeLink {
  slug: string;
  nameHe: string;
}

/**
 * The static hero shown when no banner of the hero section is live (today's hero): the fixed text stays in the
 * storefront; the photo is the first best seller's, the buttons go to the first furniture type ("לכל ה…") and the
 * first room ("קנייה לפי חדר").
 */
export interface HomeHeroFallback {
  image: ImageRef | null;
  /** The first top-level category with products (today's `menu.categories()[0]`). */
  category: HomeLink | null;
  /** The first room with products (today's `menu.rooms()[0]`). */
  room: HomeLink | null;
}

/** A furniture-type tile: the photo of the category's first product in the default listing order. */
export interface HomeCategoryTile extends HomeLink {
  image: ImageRef | null;
}

/** A room with its top-level furniture types, as the main menu lists them (decision 44), with tile photos. */
export interface HomeRoom extends HomeLink {
  categories: HomeCategoryTile[];
}

interface HomeSectionBase {
  id: number;
  /** The editor's title; null = none (the rooms block titles each room by its name). */
  titleHe: string | null;
}

/**
 * One resolved section of `GET /api/content/home`. Hidden sections and sections with nothing to show (no room, no
 * category tile left, no product, no live banner in a pair) are left out; a hero always shows (its fallback).
 */
export type HomeSectionView =
  | (HomeSectionBase & { kind: 'hero'; banner: BannerView | null; fallback: HomeHeroFallback })
  | (HomeSectionBase & { kind: 'trust' })
  | (HomeSectionBase & { kind: 'rooms'; rooms: HomeRoom[] })
  | (HomeSectionBase & { kind: 'categories'; categories: HomeCategoryTile[] })
  | (HomeSectionBase & {
      kind: 'products';
      items: ProductCard[];
      /** "לכל המוצרים": `/category/<slug>` or `/room/<slug>` for those sources, else null. */
      link: string | null;
    })
  | (HomeSectionBase & {
      kind: 'banner_pair';
      /** One or two live banners (one → full width). */
      banners: BannerView[];
    });

/** `GET /api/content/home`: the visible sections in order. */
export interface HomeView {
  sections: HomeSectionView[];
}

/** References of a section the site cannot show now (deleted, hidden, inactive or ended); the admin marks them. */
export interface HomeSectionUnavailable {
  bannerIds: number[];
  categoryIds: number[];
  productIds: number[];
  /** The category, room or promotion of a product source is gone, hidden, or not a live usable promotion. */
  source: boolean;
}

/** A section in the admin: its kind and settings, title and switch, and what the site cannot show of it now. */
export type AdminHomeSection = HomeSectionConfig & {
  id: number;
  titleHe: string | null;
  visible: boolean;
  unavailable: HomeSectionUnavailable;
};

/**
 * `GET /api/admin/content/promotion-sources` (content.manage): the promotions a home product row may use (automatic, on
 * categories or products, not members-only). `usable`: the site shows it now (active, inside its dates, not used up).
 */
export interface AdminPromotionSource {
  id: number;
  name: string;
  usable: boolean;
}

/** `GET /api/admin/content/home`: every section in order; `updatedAt` (the newest section's) is sent back on save. */
export interface AdminHome {
  sections: AdminHomeSection[];
  updatedAt: string;
}

/** A section of the save: `id` of an existing section, left out for a new one. */
export type AdminHomeSectionInput = HomeSectionConfig & {
  id?: number;
  titleHe: string | null;
  visible: boolean;
};

/** `PUT /api/admin/content/home`: the whole list in page order (1–20 sections); sections not sent are removed. */
export interface AdminHomeInput {
  sections: AdminHomeSectionInput[];
  expectedUpdatedAt?: string;
}
