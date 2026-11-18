-- CreateEnum
CREATE TYPE "home_section_kind" AS ENUM ('hero', 'trust', 'rooms', 'categories', 'products', 'banner_pair');

-- CreateTable
CREATE TABLE "home_sections" (
    "id" SERIAL NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "kind" "home_section_kind" NOT NULL,
    "title_he" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "home_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "home_sections_sort_order_idx" ON "home_sections"("sort_order");


-- Decision 98: the page never starts empty. These rows reproduce today's home page exactly: the static hero (no
-- banners), the trust strip, the rooms block, best sellers and new arrivals (four each).
INSERT INTO "home_sections" ("id", "sort_order", "kind", "title_he", "visible", "config", "updated_at")
VALUES
  (1, 0, 'hero', NULL, true, '{"bannerIds": []}', CURRENT_TIMESTAMP),
  (2, 1, 'trust', NULL, true, '{}', CURRENT_TIMESTAMP),
  (3, 2, 'rooms', NULL, true, '{}', CURRENT_TIMESTAMP),
  (4, 3, 'products', 'הנמכרים ביותר', true, '{"source": {"kind": "bestsellers"}, "count": 4}', CURRENT_TIMESTAMP),
  (5, 4, 'products', 'חדש באתר', true, '{"source": {"kind": "newest"}, "count": 4}', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

SELECT setval(pg_get_serial_sequence('home_sections', 'id'), (SELECT MAX("id") FROM "home_sections"));
