import {
  CHECKOUT_EMAIL_PATTERN,
  CONTENT_LIMITS,
  CONTENT_SLUG_PATTERN,
  type AdminAnnouncementInput,
  type AdminBannerInput,
  type AdminFaqGroupInput,
  type AdminFaqItemInput,
  type AdminInfoPageInput,
  type AdminSiteContentInput,
} from '@hg/models';
import { isSafeContentLink, sanitizeContentHtml, type ContentHtmlMode } from '../catalog/description-html.js';
import { time } from '../promotions/promotions-admin-input.js';
import { invalid, invalidLink } from './content-errors.js';

/**
 * Request bodies of `/api/admin/content/*` (Phase 8 §5, §9). Hand-written checks like the other admin inputs
 * (`promotions-admin-input.ts`): every problem is a 400 `invalid` with its field, and a link field that is not https,
 * mailto, tel or a site path is `invalid_link`. Rich text is sanitized here (`page` for info pages, `inline` for the
 * shipping text and FAQ answers), so only sanitized HTML ever reaches the database; a text with no words is refused.
 */
type Body = Record<string, unknown>;

/** Raw rich-text input is bounded before sanitizing (the stored, sanitized text has its own limit). */
const MAX_RAW_HTML = 200_000;
const MAX_SORT = 9_999;
const MAX_EMAIL = 254;
const MAX_LINK = 2_000;
/** Israeli or international: digits, dashes and spaces, an optional leading "+" (shown as written). */
const PHONE = /^\+?[0-9][0-9 -]{4,18}[0-9]$/;
/** wa.me number: digits only, international form without "+". */
const WHATSAPP = /^[1-9][0-9]{7,14}$/;
// oxlint-disable-next-line no-control-regex -- control characters (new lines included) are refused in one-line texts.
const CONTROL = /[\u0000-\u001f\u007f]/;

const asBody = (raw: unknown): Body => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {});

/** A required one-line text, trimmed, 1..max characters. */
function line(b: Body, key: string, max: number, field = key): string {
  const value = typeof b[key] === 'string' ? (b[key] as string).trim() : '';
  if (!value || value.length > max || CONTROL.test(value)) throw invalid(field);
  return value;
}

/** An optional one-line text: missing, null or blank → null. */
function optionalLine(b: Body, key: string, max: number, field = key): string | null {
  const value = b[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field);
  return value.trim() ? line(b, key, max, field) : null;
}

function flag(b: Body, key: string, field = key): boolean {
  const value = b[key];
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
}

function int(b: Body, key: string, min: number, max: number, field = key): number {
  const value = b[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

/** Sanitized rich text; refused when empty after sanitizing or longer than the stored limit. */
function richText(b: Body, key: string, mode: ContentHtmlMode, field = key): string {
  const value = b[key];
  if (typeof value !== 'string' || value.length > MAX_RAW_HTML) throw invalid(field);
  const clean = sanitizeContentHtml(value, mode);
  if (!clean || clean.length > CONTENT_LIMITS.body) throw invalid(field);
  return clean;
}

/** An optional link field: https, mailto, tel or a site path (`isSafeContentLink`), else `invalid_link`. */
function link(b: Body, key: string): string | null {
  const value = b[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidLink(key);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINK || !isSafeContentLink(trimmed)) throw invalidLink(key);
  return trimmed;
}

/** The `updatedAt` the editor started from (an ISO string); required on every update. */
export function expectedUpdatedAt(raw: unknown): string {
  const value = asBody(raw).expectedUpdatedAt;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(new Date(value).getTime()))
    throw invalid('expectedUpdatedAt');
  return value;
}

export function parseSiteContentInput(raw: unknown): AdminSiteContentInput {
  const b = asBody(raw);
  const supportPhone = line(b, 'supportPhone', 20);
  if (!PHONE.test(supportPhone)) throw invalid('supportPhone');
  const supportEmail = line(b, 'supportEmail', MAX_EMAIL);
  if (!CHECKOUT_EMAIL_PATTERN.test(supportEmail)) throw invalid('supportEmail');
  const whatsapp = line(b, 'whatsapp', 15);
  if (!WHATSAPP.test(whatsapp)) throw invalid('whatsapp');
  return { supportPhone, supportEmail, whatsapp, shippingHtml: richText(b, 'shippingHtml', 'inline') };
}

export function parseAnnouncementInput(raw: unknown): AdminAnnouncementInput {
  const b = asBody(raw);
  const textHe = line(b, 'textHe', CONTENT_LIMITS.announcementText);
  const linkUrl = link(b, 'linkUrl');
  const linkLabelHe = optionalLine(b, 'linkLabelHe', CONTENT_LIMITS.linkLabel);
  // A label without a link would show as text that looks like a link.
  if (linkLabelHe && !linkUrl) throw invalid('linkLabelHe');
  const startsAt = time(b.startsAt, 'startsAt');
  const endsAt = time(b.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) throw invalid('endsAt');
  return {
    textHe,
    linkUrl,
    linkLabelHe,
    active: flag(b, 'active'),
    sortOrder: int(b, 'sortOrder', 0, MAX_SORT),
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
  };
}

export function parseInfoPageInput(raw: unknown): AdminInfoPageInput {
  const b = asBody(raw);
  const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
  if (!slug || slug.length > CONTENT_LIMITS.slug || !CONTENT_SLUG_PATTERN.test(slug)) throw invalid('slug');
  return {
    slug,
    titleHe: line(b, 'titleHe', CONTENT_LIMITS.title),
    bodyHtml: richText(b, 'bodyHtml', 'page'),
    metaDescriptionHe: optionalLine(b, 'metaDescriptionHe', CONTENT_LIMITS.metaDescription),
    published: flag(b, 'published'),
    noindex: flag(b, 'noindex'),
    showInFooter: flag(b, 'showInFooter'),
    footerLabelHe: optionalLine(b, 'footerLabelHe', CONTENT_LIMITS.linkLabel),
    footerOrder: int(b, 'footerOrder', 0, MAX_SORT),
  };
}

export function parseFaqGroupInput(raw: unknown): AdminFaqGroupInput {
  const b = asBody(raw);
  const titleHe = line(b, 'titleHe', CONTENT_LIMITS.title);
  const sortOrder = int(b, 'sortOrder', 0, MAX_SORT);
  const published = flag(b, 'published');
  if (!Array.isArray(b.items) || b.items.length > CONTENT_LIMITS.faqItems) throw invalid('items');
  const seen = new Set<number>();
  const items = (b.items as unknown[]).map((rawItem, i): AdminFaqItemInput => {
    const item = asBody(rawItem);
    const field = (key: string) => `items.${i}.${key}`;
    let id: number | undefined;
    if (item.id !== undefined && item.id !== null) {
      id = int(item, 'id', 1, 2 ** 31 - 1, field('id'));
      if (seen.has(id)) throw invalid(field('id'));
      seen.add(id);
    }
    return {
      ...(id === undefined ? {} : { id }),
      questionHe: line(item, 'questionHe', CONTENT_LIMITS.faqQuestion, field('questionHe')),
      answerHtml: richText(item, 'answerHtml', 'inline', field('answerHtml')),
      published: flag(item, 'published', field('published')),
    };
  });
  return { titleHe, sortOrder, published, items };
}

/** The id of a content image (`POST /api/admin/content/images`); whether it exists is checked by the service. */
function imageId(b: Body, key: string, required: boolean): number | null {
  const value = b[key];
  if (!required && (value === undefined || value === null)) return null;
  return int(b, key, 1, 2 ** 31 - 1);
}

export function parseBannerInput(raw: unknown): AdminBannerInput {
  const b = asBody(raw);
  const nameHe = line(b, 'nameHe', CONTENT_LIMITS.bannerName);
  const headlineHe = line(b, 'headlineHe', CONTENT_LIMITS.bannerHeadline);
  const sublineHe = optionalLine(b, 'sublineHe', CONTENT_LIMITS.bannerSubline);
  const ctaLabelHe = optionalLine(b, 'ctaLabelHe', CONTENT_LIMITS.bannerCta);
  // The whole banner is a link, so the address is required (a missing one is `invalid_link` like a bad one).
  const linkUrl = link(b, 'linkUrl');
  if (!linkUrl) throw invalidLink('linkUrl');
  const image = imageId(b, 'imageId', true)!;
  const mobileImageId = imageId(b, 'mobileImageId', false);
  const altHe = line(b, 'altHe', CONTENT_LIMITS.bannerAlt);
  const active = flag(b, 'active');
  const startsAt = time(b.startsAt, 'startsAt');
  const endsAt = time(b.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) throw invalid('endsAt');
  return {
    nameHe,
    headlineHe,
    sublineHe,
    ctaLabelHe,
    linkUrl,
    imageId: image,
    mobileImageId,
    altHe,
    active,
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
  };
}
