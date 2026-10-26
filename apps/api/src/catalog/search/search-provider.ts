/**
 * Product search behind an interface (decision 47): PostgreSQL today, a dedicated engine
 * (Meilisearch, Typesense, Algolia...) later without touching the catalog code.
 */
export abstract class SearchProvider {
  /** Matching product ids with a relevance score (higher is better). Empty map = nothing found. */
  abstract search(query: string): Promise<Map<number, number>>;
}
