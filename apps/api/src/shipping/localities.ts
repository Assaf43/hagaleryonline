/**
 * Folds Hebrew quote variants (gershayim, geresh) and dashes (hyphen, maqaf, en/em dash, with any spaces around
 * them → one space, so "תל אביב-יפו" and "תל אביב יפו" both match "תל אביב - יפו"), trims and collapses spaces,
 * for matching. Applied to both the query and the names.
 */
export function normalizeLocality(text: string): string {
  return text
    .replace(/[״“”]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(/\s*[-־–—]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
