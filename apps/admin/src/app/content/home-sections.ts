import {
  CONTENT_LIMITS,
  HOME_SECTION_LABELS_HE,
  type AdminHome,
  type AdminHomeInput,
  type AdminHomeSection,
  type AdminHomeSectionInput,
  type HomeSectionConfig,
  type HomeSectionKind,
  type HomeSectionUnavailable,
  type ProductSource,
} from '@hg/models';

/** A section being edited: the saved fields plus a stable key for the list (new sections have no `id`). */
export type HomeDraft = HomeSectionConfig & {
  key: number;
  id?: number;
  titleHe: string | null;
  visible: boolean;
  unavailable: HomeSectionUnavailable;
};

export const NO_UNAVAILABLE: HomeSectionUnavailable = { bannerIds: [], categoryIds: [], productIds: [], source: false };

export const SECTION_KINDS = Object.keys(HOME_SECTION_LABELS_HE) as HomeSectionKind[];

export const SOURCE_KIND_LABELS = {
  bestsellers: 'הנמכרים ביותר',
  newest: 'חדש באתר',
  category: 'קטגוריה',
  room: 'חדר',
  promotion: 'מבצע',
  manual: 'בחירה ידנית',
} as const;

export const HOME_MESSAGES = {
  banners: (max: number) => `אפשר לבחור עד ${max} באנרים.`,
  categoriesRange: `יש לבחור בין ${CONTENT_LIMITS.categoryTilesMin} ל־${CONTENT_LIMITS.categoryTilesMax} קטגוריות.`,
  sourceCategory: 'יש לבחור קטגוריה.',
  sourceRoom: 'יש לבחור חדר.',
  sourcePromotion: 'יש לבחור מבצע.',
  manualRange: `יש לבחור בין 1 ל־${CONTENT_LIMITS.manualProducts} מוצרים.`,
  title: 'הכותרת יכולה להכיל עד 120 תווים.',
  fixBelow: 'יש לתקן את השדות המסומנים.',
  empty: 'צריך לפחות אזור אחד בדף הבית.',
  tooMany: `אפשר עד ${CONTENT_LIMITS.homeSections} אזורים בדף הבית.`,
} as const;

let nextKey = 1;
export const newKey = () => nextKey++;

export function toDraft(s: AdminHomeSection): HomeDraft {
  return { ...s, key: newKey() };
}

export function toDrafts(home: AdminHome): HomeDraft[] {
  return home.sections.map(toDraft);
}

/** A new section with the settings every kind starts from. */
export function newSection(kind: HomeSectionKind): HomeDraft {
  const base = { key: newKey(), titleHe: null, visible: true, unavailable: NO_UNAVAILABLE };
  switch (kind) {
    case 'hero':
    case 'banner_pair':
      return { ...base, kind, bannerIds: [] };
    case 'categories':
      return { ...base, kind, categoryIds: [] };
    case 'products':
      return { ...base, kind, source: { kind: 'bestsellers' }, count: 4 };
    default:
      return { ...base, kind };
  }
}

/** The list with the item at `index` moved by `delta` places; the ends stay put. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length || index < 0 || index >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** What the section needs before it can be saved: field name → Hebrew sentence. Empty = fine. */
export function sectionProblems(s: HomeDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if ((s.titleHe ?? '').trim().length > CONTENT_LIMITS.title) errors['titleHe'] = HOME_MESSAGES.title;
  switch (s.kind) {
    case 'hero':
      if (s.bannerIds.length > CONTENT_LIMITS.heroBanners)
        errors['bannerIds'] = HOME_MESSAGES.banners(CONTENT_LIMITS.heroBanners);
      break;
    case 'banner_pair':
      if (s.bannerIds.length > CONTENT_LIMITS.pairBanners)
        errors['bannerIds'] = HOME_MESSAGES.banners(CONTENT_LIMITS.pairBanners);
      break;
    case 'categories':
      if (
        s.categoryIds.length < CONTENT_LIMITS.categoryTilesMin ||
        s.categoryIds.length > CONTENT_LIMITS.categoryTilesMax
      )
        errors['categoryIds'] = HOME_MESSAGES.categoriesRange;
      break;
    case 'products': {
      const message = sourceProblem(s.source);
      if (message) errors['source'] = message;
      break;
    }
    default:
      break;
  }
  return errors;
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

/** The first place with a problem (0-based) and its message, or null. */
export function firstProblem(list: readonly HomeDraft[]): { index: number; message: string } | null {
  if (!list.length) return { index: -1, message: HOME_MESSAGES.empty };
  if (list.length > CONTENT_LIMITS.homeSections) return { index: -1, message: HOME_MESSAGES.tooMany };
  for (let i = 0; i < list.length; i++) {
    const problems = Object.values(sectionProblems(list[i]));
    if (problems.length) return { index: i, message: problems[0] };
  }
  return null;
}

/** One save of the whole list, in page order. */
export function homeInput(list: readonly HomeDraft[], expectedUpdatedAt: string): AdminHomeInput {
  return {
    sections: list.map((s): AdminHomeSectionInput => {
      const { key: _key, unavailable: _unavailable, id, titleHe, visible, ...config } = s;
      const title = (titleHe ?? '').trim();
      return { ...(id !== undefined ? { id } : {}), ...(config as HomeSectionConfig), titleHe: title || null, visible };
    }),
    expectedUpdatedAt,
  };
}

/** What changed, for the "unsaved changes" check: the input without the stable keys. */
export function homeSignature(list: readonly HomeDraft[]): string {
  return JSON.stringify(homeInput(list, '').sections);
}

/** True when the site cannot show some reference of the section now. */
export function hasUnavailable(u: HomeSectionUnavailable): boolean {
  return u.source || u.bannerIds.length > 0 || u.categoryIds.length > 0 || u.productIds.length > 0;
}

/** The section's own name: its title, else the kind. */
export function sectionName(s: Pick<HomeDraft, 'kind' | 'titleHe'>): string {
  return s.titleHe?.trim() || HOME_SECTION_LABELS_HE[s.kind];
}
