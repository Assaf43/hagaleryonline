/**
 * Text normalization for search (decision 47). The same function runs on the stored
 * products.search_text and on the customer's query, so both sides compare equal.
 */

const NIQQUD = /[֑-ׇ]/g;
/** Geresh, gershayim and quotes: שז׳לונג / שז'לונג / שזלונג all become שזלונג. */
const QUOTES = /[׳״'"`‘’“”]/g;
/** Hyphens, maqaf, slashes and other punctuation become spaces: תלת-מושבית → תלת מושבית. */
const SEPARATORS = /[־\-_/\\.,;:!?()[\]{}+*&|<>#@%^~=]/g;

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(SEPARATORS, ' ') // before NIQQUD: the maqaf (U+05BE) sits inside the niqqud range
    .replace(NIQQUD, '')
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Search terms of a query: normalized, de-duplicated, at least 2 characters. */
export function tokenizeQuery(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .split(' ')
        .filter((t) => t.length >= 2),
    ),
  ];
}

/** Everything a customer might type to find a product, as one normalized string. */
export function buildProductSearchText(parts: {
  modelName: string;
  nameHe: string;
  descriptionHe: string;
  categoryNamesHe: string[];
  attributeLabelsHe: string[];
  skus: string[];
}): string {
  return normalizeSearchText(
    [
      parts.modelName,
      parts.nameHe,
      ...parts.categoryNamesHe,
      ...new Set(parts.attributeLabelsHe),
      ...parts.skus,
      parts.descriptionHe,
    ].join(' '),
  );
}

/** A way to match one query term, with a weight that ranks exact matches above looser ones. */
export interface TermAlternative {
  text: string;
  weight: number;
}

const EXACT = 1;
const SYNONYM = 0.9;
const WITHOUT_PREFIX = 0.7;
/** One-letter Hebrew prefixes (ה, ו, ב, ל, כ, ש, מ): הספה → ספה, ולשטיח → שטיח. */
const HEBREW_PREFIX = /^[הובלכשמ]/;
const MIN_STEM_LENGTH = 3;

/**
 * Expands each term into the ways it may match: itself, its synonym group (ספה → ספות, sofa;
 * groups come from the admin-managed search_synonyms table), and the word without up to two
 * Hebrew prefix letters. Every alternative keeps the highest weight it was reached with.
 */
export function expandTerms(terms: string[], synonymGroups: string[][]): TermAlternative[][] {
  const groups = synonymGroups.map((g) => g.map(normalizeSearchText).filter(Boolean));
  return terms.map((term) => {
    const alternatives = new Map<string, number>();
    const add = (text: string, weight: number) => alternatives.set(text, Math.max(weight, alternatives.get(text) ?? 0));
    const addWithSynonyms = (text: string, weight: number) => {
      add(text, weight);
      for (const group of groups) {
        if (group.includes(text)) group.forEach((t) => add(t, Math.min(weight, SYNONYM)));
      }
    };

    addWithSynonyms(term, EXACT);
    // A word from the synonym list is a known word, not a prefixed one (כורסא is not כ + ורסא).
    if (groups.some((group) => group.includes(term))) return toList(alternatives);
    let stem = term;
    for (let i = 0; i < 2 && HEBREW_PREFIX.test(stem) && stem.length - 1 >= MIN_STEM_LENGTH; i++) {
      stem = stem.slice(1);
      addWithSynonyms(stem, WITHOUT_PREFIX);
    }
    return toList(alternatives);
  });
}

function toList(alternatives: Map<string, number>): TermAlternative[] {
  return [...alternatives].map(([text, weight]) => ({ text, weight }));
}
