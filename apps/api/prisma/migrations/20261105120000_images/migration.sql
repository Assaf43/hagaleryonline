-- Phase 2d: photos are linked to a color (decision 62) and stored as resized copies.
-- Also restores the trigram search index that 20261029120000_admin_auth dropped by mistake.
-- DropForeignKey
ALTER TABLE "images" DROP CONSTRAINT "images_variant_id_fkey";

-- AlterTable
ALTER TABLE "images" DROP COLUMN "variant_id",
ADD COLUMN     "color_value_id" INTEGER,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "storage_key" TEXT,
ADD COLUMN     "width" INTEGER,
ADD COLUMN     "widths" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateIndex
CREATE INDEX "products_search_text_trgm_idx" ON "products" USING GIN ("search_text" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_color_value_id_fkey" FOREIGN KEY ("color_value_id") REFERENCES "attribute_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

