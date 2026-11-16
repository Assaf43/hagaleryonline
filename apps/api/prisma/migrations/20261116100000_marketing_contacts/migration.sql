-- CreateEnum
CREATE TYPE "marketing_status" AS ENUM ('pending', 'subscribed', 'unsubscribed');

-- CreateEnum
CREATE TYPE "consent_action" AS ENUM ('requested', 'confirmed', 'withdrawn', 'provider_unsubscribed', 'released');

-- AlterEnum
ALTER TYPE "marketing_consent_source" ADD VALUE 'newsletter';

-- CreateTable
CREATE TABLE "marketing_contacts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "customer_id" UUID,
    "status" "marketing_status" NOT NULL,
    "source" "marketing_consent_source" NOT NULL,
    "consent_at" TIMESTAMP(3),
    "unsubscribed_at" TIMESTAMP(3),
    "confirm_token_hash" TEXT,
    "confirm_expires_at" TIMESTAMP(3),
    "unsubscribe_token_hash" TEXT NOT NULL,
    "sync_version" INTEGER NOT NULL DEFAULT 0,
    "synced_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consent_events" (
    "id" BIGSERIAL NOT NULL,
    "contact_id" UUID NOT NULL,
    "action" "consent_action" NOT NULL,
    "source" "marketing_consent_source",
    "text_version" TEXT,
    "actor_customer_id" UUID,
    "actor_seller_id" INTEGER,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketing_contacts_email_key" ON "marketing_contacts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_contacts_customer_id_key" ON "marketing_contacts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_contacts_confirm_token_hash_key" ON "marketing_contacts"("confirm_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_contacts_unsubscribe_token_hash_key" ON "marketing_contacts"("unsubscribe_token_hash");

-- CreateIndex
CREATE INDEX "marketing_consent_events_contact_id_at_idx" ON "marketing_consent_events"("contact_id", "at");

-- AddForeignKey
ALTER TABLE "marketing_contacts" ADD CONSTRAINT "marketing_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consent_events" ADD CONSTRAINT "marketing_consent_events_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "marketing_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Move the existing consent: one contact per customer with an e-mail and a recorded consent time. The unsubscribe
-- token hash is a SHA-256 hex of random data (built-in functions only, no pgcrypto); the raw token is never kept, so a
-- link is issued afresh when needed.
INSERT INTO "marketing_contacts" ("id", "email", "customer_id", "status", "source", "consent_at", "unsubscribed_at",
  "unsubscribe_token_hash", "created_at", "updated_at")
SELECT gen_random_uuid(), lower(btrim(c."email")), c."id",
  CASE WHEN c."marketing_consent" THEN 'subscribed'::"marketing_status" ELSE 'unsubscribed'::"marketing_status" END,
  COALESCE(c."marketing_consent_source", 'account'::"marketing_consent_source"),
  c."marketing_consent_at", c."marketing_withdrawn_at",
  encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'),
  c."marketing_consent_at", CURRENT_TIMESTAMP
FROM "customers" c
WHERE c."email" IS NOT NULL AND c."marketing_consent_at" IS NOT NULL;

INSERT INTO "marketing_consent_events" ("contact_id", "action", "source", "text_version", "actor_customer_id", "at")
SELECT m."id", 'confirmed'::"consent_action", m."source", NULL, c."id", c."marketing_consent_at"
FROM "customers" c JOIN "marketing_contacts" m ON m."customer_id" = c."id";

INSERT INTO "marketing_consent_events" ("contact_id", "action", "source", "text_version", "actor_customer_id", "at")
SELECT m."id", 'withdrawn'::"consent_action", NULL, NULL, c."id", c."marketing_withdrawn_at"
FROM "customers" c JOIN "marketing_contacts" m ON m."customer_id" = c."id"
WHERE c."marketing_withdrawn_at" IS NOT NULL;

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "marketing_consent",
DROP COLUMN "marketing_consent_at",
DROP COLUMN "marketing_consent_source",
DROP COLUMN "marketing_withdrawn_at";
