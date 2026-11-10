-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('pending_payment', 'paid', 'payment_failed', 'expired');

-- CreateEnum
CREATE TYPE "order_shipping_method" AS ENUM ('curbside', 'full_service');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "public_token" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending_payment',
    "contact" JSONB NOT NULL,
    "address" JSONB NOT NULL,
    "method" "order_shipping_method" NOT NULL,
    "shipping_total" INTEGER NOT NULL,
    "shipping_lines" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "discount_info" JSONB,
    "total" INTEGER NOT NULL,
    "delivery_estimate" JSONB NOT NULL,
    "payment_provider" TEXT NOT NULL,
    "shipping_provider" TEXT NOT NULL,
    "cart_id" UUID,
    "reserved_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "variant_id" INTEGER,
    "sku" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "name_he" TEXT NOT NULL,
    "option_labels" JSONB NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" INTEGER NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "installments" INTEGER,
    "amount" INTEGER NOT NULL,
    "raw_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_number_key" ON "orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_public_token_key" ON "orders"("public_token");

-- CreateIndex
CREATE INDEX "orders_status_reserved_until_idx" ON "orders"("status", "reserved_until");

-- CreateIndex
CREATE INDEX "orders_cart_id_idx" ON "orders"("cart_id");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Order numbers start at 100001 (spec §5.2).
ALTER SEQUENCE "orders_number_seq" START WITH 100001 RESTART WITH 100001;

-- A line holds at least one unit (a reservation of 0 or less would release stock).
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);
