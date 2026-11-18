/** A staff preview page (MKT-02) must never be cached by a proxy or the browser. */
export function previewNoStore(
  req: { query: Record<string, unknown> },
  res: { setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  if (req.query['preview'] !== undefined) res.setHeader('Cache-Control', 'no-store');
  next();
}
