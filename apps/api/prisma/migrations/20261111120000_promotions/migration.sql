-- CreateEnum
CREATE TYPE "promotion_kind" AS ENUM ('automatic', 'coupon');

-- CreateEnum
CREATE TYPE "discount_type" AS ENUM ('percent', 'fixed');

-- CreateEnum
CREATE TYPE "promotion_target" AS ENUM ('order', 'categories', 'products');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "promotion_id" INTEGER;

-- CreateTable
CREATE TABLE "promotions" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "promotion_kind" NOT NULL,
    "code" TEXT,
    "discount_type" "discount_type" NOT NULL,
    "value" INTEGER NOT NULL,
    "target" "promotion_target" NOT NULL,
    "target_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "min_subtotal" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "usage_limit" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_kind_active_idx" ON "promotions"("kind", "active");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
