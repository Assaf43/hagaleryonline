/**
 * Content management (Phase 8, spec specs/2026-11-17-phase-8-cms-design.md, decisions 97–101): the announcement bar,
 * info pages, FAQ and site details (8a). Rich-text fields hold HTML already sanitized by the API
 * (`sanitizeContentHtml`): `page` mode (h2, h3) for info pages, `inline` mode (no headings) for the shipping text and
 * FAQ answers. Dates are ISO strings; an `endsAt` is inclusive (23:59:59.999 of the Israel day).
 */

/** Length limits (characters, after trimming). */
export const CONTENT_LIMITS = {
  announcementText: 120,
  title: 120,
  metaDescription: 160,
  /** Rich-text HTML, after sanitizing. */
  body: 50_000,
  faqQuestion: 200,
} as const;

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
