-- Search (decision 47). PostgreSQL has no Hebrew stemming dictionary, so instead of tsvector we
-- match on a lower-cased denormalized products.search_text with trigrams:
--   - ILIKE '%term%'        substring match, which also covers Hebrew prefixes (הספה, לספה, וספה)
--   - word_similarity(...)  typo tolerance and plene/defective spelling (כורסה/כורסא)
-- Both use this one GIN index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "products_search_text_trgm_idx" ON "products" USING GIN ("search_text" gin_trgm_ops);
