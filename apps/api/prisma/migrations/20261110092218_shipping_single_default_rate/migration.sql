-- At most one default shipping rate (category_id NULL): the unique index on category_id allows many NULLs.
-- Keep the oldest default row if there are several, then enforce one with a partial unique index.
DELETE FROM "shipping_rates" a
USING "shipping_rates" b
WHERE a."category_id" IS NULL AND b."category_id" IS NULL AND a."id" > b."id";

CREATE UNIQUE INDEX "shipping_rates_single_default" ON "shipping_rates" ((true)) WHERE "category_id" IS NULL;
