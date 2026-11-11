-- Promotions review fixes (spec §6): enum name, order link RESTRICT + index, CHECK constraints.

-- RenameEnum (a rename keeps the column and its data; Prisma's diff would drop and re-add it)
ALTER TYPE "discount_type" RENAME TO "promotion_discount_type";

-- A promotion that orders refer to cannot be deleted.
ALTER TABLE "orders" DROP CONSTRAINT "orders_promotion_id_fkey";
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "orders_promotion_id_idx" ON "orders"("promotion_id");

-- CHECK constraints (not expressible in schema.prisma)
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_code_upper_check" CHECK ("code" IS NULL OR "code" = upper("code"));
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_code_kind_check" CHECK (("kind" = 'coupon') = ("code" IS NOT NULL));
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_value_positive_check" CHECK ("value" > 0);
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_percent_max_check" CHECK ("discount_type" <> 'percent' OR "value" <= 100);
