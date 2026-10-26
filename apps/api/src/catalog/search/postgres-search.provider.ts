import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { CacheStore } from '../../cache/cache-store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SearchProvider } from './search-provider.js';
import { expandTerms, tokenizeQuery } from './search-text.js';

/** Trigram word similarity at or above this counts as a fuzzy hit (פינטית ≈ פינתית scores 0.43; unrelated products stay under 0.3 in the seed). */
export const FUZZY_THRESHOLD = 0.4;
const MIN_FUZZY_LENGTH = 4;
/** Exact terms (1) and synonyms (0.9) get typo tolerance; prefix-stripped forms (0.7) do not. */
const MIN_FUZZY_WEIGHT = 0.9;
const SYNONYMS_TTL_MS = 5 * 60_000;
const MAX_RESULTS = 500;

/**
 * PostgreSQL search over products.search_text (see migration search_trigram).
 * Every query term must match (AND); each term matches through any of its synonyms (OR),
 * as a substring or by trigram similarity. Score = sum of the best similarity per term.
 */
@Injectable()
export class PostgresSearchProvider extends SearchProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheStore,
  ) {
    super();
  }

  async search(query: string): Promise<Map<number, number>> {
    const terms = tokenizeQuery(query);
    if (terms.length === 0) return new Map();

    const groups = await this.cache.wrap('search:synonyms', SYNONYMS_TTL_MS, async () =>
      (await this.prisma.searchSynonym.findMany()).map((s) => s.terms),
    );
    const alternatives = expandTerms(terms, groups);

    const conditions = alternatives.map(
      (alts) =>
        Prisma.sql`(${Prisma.join(
          alts.map(({ text, weight }) =>
            allowsFuzzy(text, weight)
              ? Prisma.sql`(search_text LIKE ${'%' + escapeLike(text) + '%'} OR word_similarity(${text}, search_text) >= ${FUZZY_THRESHOLD})`
              : Prisma.sql`search_text LIKE ${'%' + escapeLike(text) + '%'}`,
          ),
          ' OR ',
        )})`,
    );
    const score = Prisma.join(
      alternatives.map(
        (alts) =>
          Prisma.sql`GREATEST(${Prisma.join(
            alts.map(
              ({ text, weight }) =>
                Prisma.sql`${weight}::float8 * CASE WHEN search_text LIKE ${'%' + escapeLike(text) + '%'} THEN 1.0 ELSE ${
                  allowsFuzzy(text, weight) ? Prisma.sql`word_similarity(${text}, search_text)` : Prisma.sql`0.0`
                } END`,
            ),
            ', ',
          )})`,
      ),
      ' + ',
    );

    const rows = await this.prisma.$queryRaw<{ id: number; score: number }[]>`
      SELECT id, (${score})::float8 AS score
      FROM products
      WHERE active AND ${Prisma.join(conditions, ' AND ')}
      ORDER BY score DESC, id
      LIMIT ${MAX_RESULTS}`;

    return new Map(rows.map((r) => [r.id, r.score]));
  }
}

/**
 * Typo tolerance only for what the customer typed (or its synonyms), and only from 4 characters:
 * short or prefix-stripped words share too many trigrams with unrelated text (מנורה → נורה ≈ everything).
 */
function allowsFuzzy(text: string, weight: number): boolean {
  return weight >= MIN_FUZZY_WEIGHT && text.length >= MIN_FUZZY_LENGTH;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
