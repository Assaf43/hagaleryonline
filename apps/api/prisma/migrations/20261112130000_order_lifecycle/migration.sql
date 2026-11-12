-- CreateEnum
CREATE TYPE "order_channel" AS ENUM ('web', 'store');

-- CreateEnum
CREATE TYPE "order_actor_type" AS ENUM ('admin', 'customer', 'system');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "delivery_slot_state" AS ENUM ('proposed', 'confirmed', 'change_requested', 'superseded');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "order_status" ADD VALUE 'processing';
ALTER TYPE "order_status" ADD VALUE 'delivery_scheduled';
ALTER TYPE "order_status" ADD VALUE 'shipped';
ALTER TYPE "order_status" ADD VALUE 'delivered';
ALTER TYPE "order_status" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "attention_note" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "channel" "order_channel" NOT NULL DEFAULT 'web',
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "needs_attention" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refunded_total" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status" NOT NULL,
    "actor_type" "order_actor_type" NOT NULL,
    "actor_admin_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "admin_user_id" INTEGER,
    "provider" TEXT NOT NULL,
    "provider_refund_id" TEXT,
    "status" "refund_status" NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_slots" (
    "id" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "window_from" TEXT NOT NULL,
    "window_to" TEXT NOT NULL,
    "token_hash" TEXT,
    "state" "delivery_slot_state" NOT NULL DEFAULT 'proposed',
    "note" TEXT,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_status_events_order_id_created_at_idx" ON "order_status_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_slots_token_hash_key" ON "delivery_slots"("token_hash");

-- CreateIndex
CREATE INDEX "delivery_slots_order_id_idx" ON "delivery_slots"("order_id");

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: the refunded amount never exceeds what the order cost (spec §3).
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_total_check" CHECK ("refunded_total" BETWEEN 0 AND "total");

-- Hand-written: one non-superseded delivery slot per order (spec §3).
CREATE UNIQUE INDEX "delivery_slots_one_live_per_order" ON "delivery_slots"("order_id") WHERE "state" <> 'superseded';
