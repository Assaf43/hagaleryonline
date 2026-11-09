-- CreateEnum
CREATE TYPE "relation_kind" AS ENUM ('goes_with', 'similar');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "goes_with_autofill" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "similar_autofill" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "product_relations" (
    "product_id" INTEGER NOT NULL,
    "related_id" INTEGER NOT NULL,
    "kind" "relation_kind" NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "product_relations_pkey" PRIMARY KEY ("product_id","related_id","kind"),
    -- A product cannot link to itself (decision 67). Not modelled by Prisma; kept by hand.
    CONSTRAINT "product_relations_not_self" CHECK ("product_id" <> "related_id")
);

-- CreateIndex
CREATE INDEX "product_relations_related_id_idx" ON "product_relations"("related_id");

-- AddForeignKey
ALTER TABLE "product_relations" ADD CONSTRAINT "product_relations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_relations" ADD CONSTRAINT "product_relations_related_id_fkey" FOREIGN KEY ("related_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
