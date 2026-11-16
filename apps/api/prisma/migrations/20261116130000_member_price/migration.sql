-- AlterTable
ALTER TABLE "variants" ADD COLUMN     "member_price" INTEGER;

-- Club member price: positive and lower than the price (CLB-03, decision 91).
ALTER TABLE "variants" ADD CONSTRAINT "variants_member_price_lower" CHECK ("member_price" IS NULL OR ("member_price" > 0 AND "member_price" < "price"));
