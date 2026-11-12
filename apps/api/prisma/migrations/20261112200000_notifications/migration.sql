-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('sent', 'failed');

-- CreateTable
CREATE TABLE "notification_log" (
    "id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "recipient_masked" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" "notification_status" NOT NULL,
    "order_id" UUID,
    "subject" TEXT,
    "body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_log_created_at_idx" ON "notification_log"("created_at");

-- CreateIndex
CREATE INDEX "notification_log_order_id_idx" ON "notification_log"("order_id");

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

