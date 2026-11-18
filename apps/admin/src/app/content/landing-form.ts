import {
  CONTENT_LIMITS,
  CONTENT_SLUG_PATTERN,
  type AdminContentImage,
  type AdminLandingPage,
  type AdminLandingPageInput,
  type LandingState,
  type LandingStatus,
  type ProductSource,
} from '@hg/models';
import { endFields, israelEndToUtc, israelStartToUtc, startFields } from '../core/israel-time';
import { contentDatesText } from './content-status';
import { HOME_MESSAGES } from './home-sections';

export interface LandingForm {
  slug: string;
  titleHe: string;
  sublineHe: string;
  introHtml: string;
  outroHtml: string;
  image: AdminContentImage | null;
  mobileImage: AdminContentImage | null;
  altHe: string;
  source: ProductSource;
  status: LandingStatus;
  startDate: string;
  endDate: string;
  /** Kept as stored, so a time set elsewhere is not lost; the form only edits whole Israel days. */
  startTime: string;
  endTime: string;
  endedLinkUrl: string;
  metaDescriptionHe: string;
  noindex: boolean;
}

export type LandingField =
  | 'slug'
  | 'titleHe'
  | 'sublineHe'
  | 'introHtml'
  | 'outroHtml'
  | 'image'
  | 'altHe'
  | 'source'
  | 'startDate'
  | 'endDate'
  | 'endedLinkUrl'
  | 'metaDescriptionHe';
export type LandingErrors = Partial<Record<LandingField, string>>;

export const LANDING_MESSAGES = {
  slug: 'הכתובת צריכה להכיל אותיות באנגלית קטנות, ספרות ומקפים בלבד (למשל: winter-sale).',
  title: `יש למלא כותרת (עד ${CONTENT_LIMITS.title} תווים).`,
  subline: `משפט המשנה יכול להכיל עד ${CONTENT_LIMITS.landingSubline} תווים.`,
  intro: 'יש למלא את טקסט הפתיחה.',
  image: 'יש להעלות תמונת פתיחה לדסקטופ.',
  alt: `יש לתאר את התמונה לקוראי מסך (עד ${CONTENT_LIMITS.landingAlt} תווים).`,
  endedLink: 'הקישור אחרי הסיום צריך להיות כתובת באתר שמתחילה ב-/ או כתובת https://.',
  meta: `תיאור לגוגל יכול להכיל עד ${CONTENT_LIMITS.metaDescription} תווים.`,
  dateRange: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
} as const;

export const LANDING_STATE_LABELS: Record<LandingState, string> = {
  draft: 'טיוטה',
  scheduled: 'מתוזמן',
  live: 'פעיל',
  ended: 'הסתיים',
};

export const LANDING_STATUS_LABELS: Record<LandingStatus, string> = { draft: 'טיוטה', published: 'מפורסם' };

export function emptyLandingForm(): LandingForm {
  return {
    slug: '',
    titleHe: '',
    sublineHe: '',
    introHtml: '',
    outroHtml: '',
    image: null,
    mobileImage: null,
    altHe: '',
    source: { kind: 'bestsellers' },
    status: 'draft',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
    endedLinkUrl: '/',
    metaDescriptionHe: '',
    noindex: false,
  };
}

export function toLandingForm(p: AdminLandingPage): LandingForm {
  const start = startFields(p.startsAt);
  const end = endFields(p.endsAt);
  return {
    slug: p.slug,
    titleHe: p.titleHe,
    sublineHe: p.sublineHe ?? '',
    introHtml: p.introHtml,
    outroHtml: p.outroHtml ?? '',
    image: { id: p.imageId, image: p.image },
    mobileImage: p.mobileImage && p.mobileImageId !== null ? { id: p.mobileImageId, image: p.mobileImage } : null,
    altHe: p.altHe,
    source: p.source,
    status: p.status,
    startDate: start.date,
    endDate: end.date,
    startTime: start.time,
    endTime: end.time,
    endedLinkUrl: p.endedLinkUrl,
    metaDescriptionHe: p.metaDescriptionHe ?? '',
    noindex: p.noindex,
  };
}

function sourceProblem(source: ProductSource): string | null {
  switch (source.kind) {
    case 'category':
      return source.id > 0 ? null : HOME_MESSAGES.sourceCategory;
    case 'room':
      return source.id > 0 ? null : HOME_MESSAGES.sourceRoom;
    case 'promotion':
      return source.id > 0 ? null : HOME_MESSAGES.sourcePromotion;
    case 'manual':
      return source.productIds.length >= 1 && source.productIds.length <= CONTENT_LIMITS.manualProducts
        ? null
        : HOME_MESSAGES.manualRange;
    default:
      return null;
  }
}

/** A site path or an https address; the API checks again (`invalid_link`). */
export function endedLinkAllowed(url: string): boolean {
  return /^\/(?!\/)\S*$/.test(url) || /^https:\/\/\S+$/i.test(url);
}

/** The API input, or the errors that stop it. */
export function landingInput(f: LandingForm): { input: AdminLandingPageInput | null; errors: LandingErrors } {
  const errors: LandingErrors = {};
  const slug = f.slug.trim();
  const title = f.titleHe.trim();
  const subline = f.sublineHe.trim();
  const alt = f.altHe.trim();
  const ended = f.endedLinkUrl.trim();
  const meta = f.metaDescriptionHe.trim();
  const hasText = (html: string) => /<img\b/i.test(html) || html.replace(/<[^>]*>|&nbsp;/g, '').trim() !== '';
  if (!slug || slug.length > CONTENT_LIMITS.slug || !CONTENT_SLUG_PATTERN.test(slug))
    errors.slug = LANDING_MESSAGES.slug;
  if (!title || title.length > CONTENT_LIMITS.title) errors.titleHe = LANDING_MESSAGES.title;
  if (subline.length > CONTENT_LIMITS.landingSubline) errors.sublineHe = LANDING_MESSAGES.subline;
  if (!hasText(f.introHtml)) errors.introHtml = LANDING_MESSAGES.intro;
  if (!f.image) errors.image = LANDING_MESSAGES.image;
  if (!alt || alt.length > CONTENT_LIMITS.landingAlt) errors.altHe = LANDING_MESSAGES.alt;
  const sourceError = sourceProblem(f.source);
  if (sourceError) errors.source = sourceError;
  if (ended && !endedLinkAllowed(ended)) errors.endedLinkUrl = LANDING_MESSAGES.endedLink;
  if (meta.length > CONTENT_LIMITS.metaDescription) errors.metaDescriptionHe = LANDING_MESSAGES.meta;
  const startsAt = f.startDate ? israelStartToUtc(f.startDate, f.startTime) : null;
  const endsAt = f.endDate ? israelEndToUtc(f.endDate, f.endTime) : null;
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.endDate = LANDING_MESSAGES.dateRange;
  if (Object.keys(errors).length || !f.image) return { input: null, errors };
  return {
    input: {
      slug,
      titleHe: title,
      sublineHe: subline || null,
      introHtml: f.introHtml,
      outroHtml: hasText(f.outroHtml) ? f.outroHtml : null,
      imageId: f.image.id,
      mobileImageId: f.mobileImage?.id ?? null,
      altHe: alt,
      source: f.source,
      status: f.status,
      startsAt,
      endsAt,
      endedLinkUrl: ended || null,
      metaDescriptionHe: meta || null,
      noindex: f.noindex,
    },
    errors,
  };
}

/** "1.12.2026 – 31.12.2026" and the like, for the list. */
export const landingDatesText = (p: Pick<AdminLandingPage, 'startsAt' | 'endsAt'>) => contentDatesText(p);
