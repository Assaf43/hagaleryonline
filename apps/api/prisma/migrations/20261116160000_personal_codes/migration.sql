-- Personal codes (Phase 7c, decisions 93–94, spec §5.2): personal-code templates, the codes, and the welcome
-- benefit moved from an automatic promotion to a template.

-- AlterEnum: the type is rebuilt instead of `ADD VALUE`, so the data move below can use the new value in the same
-- transaction (a value added by ADD VALUE cannot be used before its transaction commits).
-- The CHECK that compares the kind (migration promotions_checks) is dropped and added again around it.
ALTER TABLE "promotions" DROP CONSTRAINT "promotions_code_kind_check";
ALTER TYPE "promotion_kind" RENAME TO "promotion_kind_old";
CREATE TYPE "promotion_kind" AS ENUM ('automatic', 'coupon', 'personal_template');
ALTER TABLE "promotions" ALTER COLUMN "kind" TYPE "promotion_kind" USING ("kind"::text::"promotion_kind");
DROP TYPE "promotion_kind_old";
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_code_kind_check" CHECK (("kind" = 'coupon') = ("code" IS NOT NULL));

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "personal_code_id" INTEGER;

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "validity_days" INTEGER;

-- CreateTable
CREATE TABLE "personal_codes" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "promotion_id" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "issued_by_id" INTEGER,
    "order_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_codes_code_key" ON "personal_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "personal_codes_order_id_key" ON "personal_codes"("order_id");

-- CreateIndex
CREATE INDEX "personal_codes_customer_id_idx" ON "personal_codes"("customer_id");

-- CreateIndex
CREATE INDEX "personal_codes_promotion_id_idx" ON "personal_codes"("promotion_id");

-- CreateIndex
CREATE INDEX "orders_personal_code_id_idx" ON "orders"("personal_code_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_personal_code_id_fkey" FOREIGN KEY ("personal_code_id") REFERENCES "personal_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_codes" ADD CONSTRAINT "personal_codes_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_codes" ADD CONSTRAINT "personal_codes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_codes" ADD CONSTRAINT "personal_codes_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_codes" ADD CONSTRAINT "personal_codes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------- Hand-written (not expressible in schema.prisma) ----------

-- Data move (decision 93, spec §5.2): the automatic welcome promotions become personal-code templates valid 30 days.
-- Discounts already on orders are untouched (their snapshot and promotion link stay).
UPDATE "promotions" SET "kind" = 'personal_template', "validity_days" = 30 WHERE "is_welcome" AND "kind" = 'automatic';

-- validity_days is set exactly for a template, 1–365 days.
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_validity_days_check" CHECK (
  ("kind" = 'personal_template') = ("validity_days" IS NOT NULL) AND ("validity_days" IS NULL OR "validity_days" BETWEEN 1 AND 365)
);
-- The welcome mark only on a template.
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_welcome_template_check" CHECK (NOT "is_welcome" OR "kind" = 'personal_template');

-- At most one active welcome template (was: one active welcome promotion, migration welcome_promotion).
DROP INDEX "promotions_one_active_welcome";
CREATE UNIQUE INDEX "promotions_one_active_welcome" ON "promotions" ("is_welcome")
  WHERE "is_welcome" AND "active" AND "kind" = 'personal_template';

-- Codes are stored in their normalized (upper-case) form, like coupon codes.
ALTER TABLE "personal_codes" ADD CONSTRAINT "personal_codes_code_upper_check" CHECK ("code" = upper("code"));
