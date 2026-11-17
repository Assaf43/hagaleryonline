/**
 * Content management (Phase 8, spec specs/2026-11-17-phase-8-cms-design.md, decisions 97–101): the announcement bar,
 * info pages, FAQ and site details (8a). Rich-text fields hold HTML already sanitized by the API
 * (`sanitizeContentHtml`): `page` mode (h2, h3) for info pages, `inline` mode (no headings) for the shipping text and
 * FAQ answers. Dates are ISO strings; an `endsAt` is inclusive (23:59:59.999 of the Israel day).
 * 8b adds content images and banners (NAV-05).
 */
import type { ImageRef } from './catalog.js';

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
 * banner a home section uses cannot be deleted; `sections` names them), `not_found`.
 */
export type ContentErrorCode =
  'conflict' | 'invalid' | 'invalid_link' | 'slug_taken' | 'system_page' | 'banner_in_use' | 'not_found';

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
