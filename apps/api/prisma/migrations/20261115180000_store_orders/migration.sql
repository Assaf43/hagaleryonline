-- CreateEnum
CREATE TYPE "customer_origin" AS ENUM ('web', 'store');

-- AlterEnum
ALTER TYPE "marketing_consent_source" ADD VALUE 'store';

-- AlterTable
ALTER TABLE "carts" ADD COLUMN     "seller_id" INTEGER,
ADD COLUMN     "store_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "store_customer_id" UUID;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "created_by_seller_id" INTEGER,
ADD COLUMN     "created_via" "customer_origin" NOT NULL DEFAULT 'web',
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "seller_id" INTEGER,
ADD COLUMN     "store_id" INTEGER;

-- CreateTable
CREATE TABLE "stores" (
    "id" SERIAL NOT NULL,
    "name_he" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "hours_he" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carts_seller_id_idx" ON "carts"("seller_id");

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_store_customer_id_fkey" FOREIGN KEY ("store_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_seller_id_fkey" FOREIGN KEY ("created_by_seller_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A store order has both a seller and a store; a web order has neither (Phase 6, spec §4.6).
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_channel_check"
  CHECK (("channel" = 'store') = ("seller_id" IS NOT NULL AND "store_id" IS NOT NULL));

-- The one store, edited by the Super Admin (spec §4.4). Reference data: also used in production.
INSERT INTO "stores" ("name_he", "address", "hours_he", "phone", "updated_at") VALUES ('החנות', '', '', '', CURRENT_TIMESTAMP);
