-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketing_consent_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "is_welcome" BOOLEAN NOT NULL DEFAULT false;


-- At most one active welcome promotion (decision 79); not expressible in the Prisma schema.
CREATE UNIQUE INDEX "promotions_one_active_welcome" ON "promotions" ("is_welcome") WHERE "is_welcome" AND "active";
