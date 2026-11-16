-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "at_member_price" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pricing" TEXT NOT NULL DEFAULT 'regular';

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "applies_to_member_prices" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "members_only" BOOLEAN NOT NULL DEFAULT false;

-- Which of the two pricings an order was charged at (decision 92).
ALTER TABLE "orders" ADD CONSTRAINT "orders_pricing_check" CHECK ("pricing" IN ('regular', 'member'));
