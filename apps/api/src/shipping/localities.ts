/** Folds Hebrew quote variants (gershayim, geresh), trims and collapses spaces, for matching. */
export function normalizeLocality(text: string): string {
  return text.replace(/[״“”]/g, '"').replace(/[׳‘’]/g, "'").replace(/\s+/g, ' ').trim();
}
