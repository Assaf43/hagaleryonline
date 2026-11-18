import {
  HOME_PRODUCT_COUNTS,
  HOME_SECTION_LABELS_HE,
  type HomeProductCount,
  type HomeSectionConfig,
  type HomeSectionKind,
  type ProductSource,
} from '@hg/models';
import { HomeSectionKind as DbKind, type Prisma } from '../../generated/prisma/client.js';
import type { AuditView } from '../../shipping/shipping-audit.js';

/** Database enum ↔ API kind. */
export const KIND: Record<DbKind, HomeSectionKind> = {
  [DbKind.HERO]: 'hero',
  [DbKind.TRUST]: 'trust',
  [DbKind.ROOMS]: 'rooms',
  [DbKind.CATEGORIES]: 'categories',
  [DbKind.PRODUCTS]: 'products',
  [DbKind.BANNER_PAIR]: 'banner_pair',
};
export const DB_KIND = Object.fromEntries(Object.entries(KIND).map(([db, kind]) => [kind, db])) as Record<
  HomeSectionKind,
  DbKind
>;

type Json = Record<string, unknown>;
const asJson = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const ids = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id) && id > 0) : [];

/**
 * A stored row as its kind and settings. Rows are written only by the checked save and the migration; anything odd is
 * read leniently (missing ids as none, an unreadable source as an empty manual pick, an odd count as 4), so the page
 * never breaks on a row.
 */
export function storedConfig(row: { kind: DbKind; config: unknown }): HomeSectionConfig {
  const config = asJson(row.config);
  const kind = KIND[row.kind];
  switch (kind) {
    case 'hero':
    case 'banner_pair':
      return { kind, bannerIds: ids(config.bannerIds) };
    case 'trust':
    case 'rooms':
      return { kind };
    case 'categories':
      return { kind, categoryIds: ids(config.categoryIds) };
    case 'products': {
      const count = HOME_PRODUCT_COUNTS.includes(config.count as HomeProductCount)
        ? (config.count as HomeProductCount)
        : 4;
      return { kind, source: storedSource(config.source), count };
    }
  }
}

/** A stored product source (a home section's `config.source`, a landing page's `source`), read leniently. */
export function storedSource(value: unknown): ProductSource {
  const source = asJson(value);
  switch (source.kind) {
    case 'bestsellers':
    case 'newest':
      return { kind: source.kind };
    case 'category':
    case 'room':
    case 'promotion':
      return Number.isInteger(source.id) ? { kind: source.kind, id: source.id as number } : MISSING;
    case 'manual':
      return { kind: 'manual', productIds: ids(source.productIds) };
    default:
      return MISSING;
  }
}
const MISSING: ProductSource = { kind: 'manual', productIds: [] };

/** The `config` column of a section: its settings without the kind (the kind has its own column). */
export function configJson(config: HomeSectionConfig): Prisma.InputJsonObject {
  switch (config.kind) {
    case 'hero':
    case 'banner_pair':
      return { bannerIds: config.bannerIds };
    case 'trust':
    case 'rooms':
      return {};
    case 'categories':
      return { categoryIds: config.categoryIds };
    case 'products':
      return { source: config.source as Prisma.InputJsonObject, count: config.count };
  }
}

/** Banner ids a section uses (hero, banner pair). */
export function bannerIdsOf(config: HomeSectionConfig): number[] {
  return config.kind === 'hero' || config.kind === 'banner_pair' ? config.bannerIds : [];
}

/** A section as people read it: its title, else the kind's Hebrew name (`banner_in_use`). */
export function homeSectionName(titleHe: string | null, kind: HomeSectionKind): string {
  return titleHe ?? HOME_SECTION_LABELS_HE[kind];
}

/** A product source as one readable audit text (ids only). */
export function sourceText(source: ProductSource): string {
  switch (source.kind) {
    case 'bestsellers':
      return 'הנמכרים ביותר';
    case 'newest':
      return 'חדש באתר';
    case 'category':
      return `קטגוריה #${source.id}`;
    case 'room':
      return `חדר #${source.id}`;
    case 'promotion':
      return `מבצע #${source.id}`;
    case 'manual':
      return `בחירה ידנית: ${source.productIds.map((id) => `#${id}`).join(', ')}`;
  }
}

const list = (label: string, values: number[]) =>
  values.length ? `${label}: ${values.map((id) => `#${id}`).join(', ')}` : `${label}: אין`;

/** One section as an audit line: kind, title, shown or hidden, and its settings (ids only). */
function sectionText(section: { titleHe: string | null; visible: boolean; config: HomeSectionConfig }): string {
  const { config } = section;
  const parts = [HOME_SECTION_LABELS_HE[config.kind]];
  if (section.titleHe) parts.push(`"${section.titleHe}"`);
  parts.push(section.visible ? 'מוצג' : 'מוסתר');
  if (config.kind === 'hero' || config.kind === 'banner_pair') parts.push(list('באנרים', config.bannerIds));
  if (config.kind === 'categories') parts.push(list('קטגוריות', config.categoryIds));
  if (config.kind === 'products') parts.push(`מקור: ${sourceText(config.source)}`, `${config.count} מוצרים`);
  return parts.join(' · ');
}

/** The whole page for the audit log: one readable line per place ("מקום 1", "מקום 2", …), in page order. */
export function homeAudit(sections: { titleHe: string | null; visible: boolean; config: HomeSectionConfig }[]) {
  const view: AuditView = {};
  sections.forEach((section, i) => (view[`מקום ${i + 1}`] = sectionText(section)));
  return view;
}
