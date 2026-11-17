import { CONTENT_LIMITS, type AdminBanner, type AdminBannerInput, type AdminContentImage } from '@hg/models';
import { endFields, israelEndToUtc, israelStartToUtc, startFields } from '../core/israel-time';

export interface BannerForm {
  nameHe: string;
  headlineHe: string;
  sublineHe: string;
  ctaLabelHe: string;
  linkUrl: string;
  /** The desktop photo (required) and the phone photo (optional), as uploaded or as stored. */
  image: AdminContentImage | null;
  mobileImage: AdminContentImage | null;
  altHe: string;
  active: boolean;
  startDate: string;
  endDate: string;
  /** Kept as stored, so a time set elsewhere is not lost; the form only edits whole Israel days. */
  startTime: string;
  endTime: string;
}

export type BannerField =
  'nameHe' | 'headlineHe' | 'sublineHe' | 'ctaLabelHe' | 'linkUrl' | 'image' | 'altHe' | 'startDate' | 'endDate';
export type BannerErrors = Partial<Record<BannerField, string>>;

export const BANNER_MESSAGES = {
  name: `יש למלא שם פנימי לבאנר (עד ${CONTENT_LIMITS.bannerName} תווים).`,
  headline: `יש למלא כותרת (עד ${CONTENT_LIMITS.bannerHeadline} תווים).`,
  subline: `שורת המשנה יכולה להכיל עד ${CONTENT_LIMITS.bannerSubline} תווים.`,
  cta: `טקסט הכפתור יכול להכיל עד ${CONTENT_LIMITS.bannerCta} תווים.`,
  link: 'יש למלא קישור: https://, mailto:, tel: או כתובת באתר שמתחילה ב-/.',
  image: 'יש להעלות תמונה לדסקטופ.',
  alt: `יש לתאר את התמונה לקוראי מסך (עד ${CONTENT_LIMITS.bannerAlt} תווים).`,
  dateRange: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
} as const;

export function emptyBannerForm(): BannerForm {
  return {
    nameHe: '',
    headlineHe: '',
    sublineHe: '',
    ctaLabelHe: '',
    linkUrl: '',
    image: null,
    mobileImage: null,
    altHe: '',
    active: true,
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
  };
}

export function toBannerForm(b: AdminBanner): BannerForm {
  const start = startFields(b.startsAt);
  const end = endFields(b.endsAt);
  return {
    nameHe: b.nameHe,
    headlineHe: b.headlineHe,
    sublineHe: b.sublineHe ?? '',
    ctaLabelHe: b.ctaLabelHe ?? '',
    linkUrl: b.linkUrl,
    image: { id: b.imageId, image: b.image },
    mobileImage: b.mobileImage && b.mobileImageId !== null ? { id: b.mobileImageId, image: b.mobileImage } : null,
    altHe: b.altHe,
    active: b.active,
    startDate: start.date,
    endDate: end.date,
    startTime: start.time,
    endTime: end.time,
  };
}

/** The API input, or the errors that stop it. The link is checked again by the API. */
export function bannerInput(f: BannerForm): { input: AdminBannerInput | null; errors: BannerErrors } {
  const errors: BannerErrors = {};
  const name = f.nameHe.trim();
  const headline = f.headlineHe.trim();
  const subline = f.sublineHe.trim();
  const cta = f.ctaLabelHe.trim();
  const link = f.linkUrl.trim();
  const alt = f.altHe.trim();
  if (!name || name.length > CONTENT_LIMITS.bannerName) errors.nameHe = BANNER_MESSAGES.name;
  if (!headline || headline.length > CONTENT_LIMITS.bannerHeadline) errors.headlineHe = BANNER_MESSAGES.headline;
  if (subline.length > CONTENT_LIMITS.bannerSubline) errors.sublineHe = BANNER_MESSAGES.subline;
  if (cta.length > CONTENT_LIMITS.bannerCta) errors.ctaLabelHe = BANNER_MESSAGES.cta;
  if (!link) errors.linkUrl = BANNER_MESSAGES.link;
  if (!f.image) errors.image = BANNER_MESSAGES.image;
  if (!alt || alt.length > CONTENT_LIMITS.bannerAlt) errors.altHe = BANNER_MESSAGES.alt;
  const startsAt = f.startDate ? israelStartToUtc(f.startDate, f.startTime) : null;
  const endsAt = f.endDate ? israelEndToUtc(f.endDate, f.endTime) : null;
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.endDate = BANNER_MESSAGES.dateRange;
  if (Object.keys(errors).length || !f.image) return { input: null, errors };
  return {
    input: {
      nameHe: name,
      headlineHe: headline,
      sublineHe: subline || null,
      ctaLabelHe: cta || null,
      linkUrl: link,
      imageId: f.image.id,
      mobileImageId: f.mobileImage?.id ?? null,
      altHe: alt,
      active: f.active,
      startsAt,
      endsAt,
    },
    errors,
  };
}
