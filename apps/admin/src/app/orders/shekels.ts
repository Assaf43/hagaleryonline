/**
 * Shekels typed by staff ("250", "250.5", "19.99", at most 2 decimals) → integer agorot, converted once without
 * floating-point drift. Null when it is not a positive-or-zero amount.
 */
export function parseShekels(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
}
