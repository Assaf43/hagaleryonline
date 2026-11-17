/** A banner or tile link: `https:`, `mailto:` and `tel:` are plain links (same tab); a site path uses the router. */
export interface LinkTarget {
  external: boolean;
  href: string;
  path: string;
  /** Repeated keys become arrays. */
  queryParams: Record<string, string | string[]>;
  fragment: string | undefined;
}

export function linkTarget(url: string): LinkTarget {
  if (!url.startsWith('/')) return { external: true, href: url, path: url, queryParams: {}, fragment: undefined };
  const parsed = new URL(url, 'https://site.invalid');
  const queryParams: Record<string, string | string[]> = {};
  for (const key of new Set(parsed.searchParams.keys())) {
    const values = parsed.searchParams.getAll(key);
    queryParams[key] = values.length === 1 ? values[0] : values;
  }
  return {
    external: false,
    href: url,
    path: parsed.pathname,
    queryParams,
    fragment: parsed.hash ? parsed.hash.slice(1) : undefined,
  };
}
