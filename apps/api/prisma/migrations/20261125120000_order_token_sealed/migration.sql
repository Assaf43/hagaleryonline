-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "public_token_sealed" TEXT,
ALTER COLUMN "public_token" DROP NOT NULL;

-- Spec 9a.7: new orders store their link token sealed only (public_token_sealed, AES-256-GCM, ORDER_TOKEN_KEY);
-- orders placed before keep the plain token until the seal-order-tokens CLI seals it. Every order keeps one of them.
ALTER TABLE "orders" ADD CONSTRAINT "orders_public_token_present"
  CHECK ("public_token" IS NOT NULL OR "public_token_sealed" IS NOT NULL);
