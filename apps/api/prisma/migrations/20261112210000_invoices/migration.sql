-- CreateEnum
CREATE TYPE "invoice_type" AS ENUM ('tax_invoice_receipt', 'credit_note');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" "invoice_type" NOT NULL,
    "refund_id" UUID,
    "provider" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "document_url" TEXT,
    "file_key" TEXT,
    "amount" INTEGER NOT NULL,
    "vat_amount" INTEGER NOT NULL,
    "vat_rate" DECIMAL(5,4) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_rates" (
    "id" SERIAL NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "effective_from" DATE NOT NULL,

    CONSTRAINT "vat_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_invoice_documents" (
    "idempotency_key" TEXT NOT NULL,
    "type" "invoice_type" NOT NULL,
    "number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_invoice_documents_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_refund_id_key" ON "invoices"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_idempotency_key_key" ON "invoices"("idempotency_key");

-- CreateIndex
CREATE INDEX "invoices_order_id_idx" ON "invoices"("order_id");

-- CreateIndex
CREATE INDEX "invoices_issued_at_idx" ON "invoices"("issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_provider_number_key" ON "invoices"("provider", "number");

-- CreateIndex
CREATE UNIQUE INDEX "vat_rates_effective_from_key" ON "vat_rates"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "mock_invoice_documents_number_key" ON "mock_invoice_documents"("number");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tax documents (spec §5.4), not expressible in schema.prisma: a positive amount, the VAT inside it, a refund
-- exactly for credit notes, and one tax invoice / receipt per order.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vat_amount_check" CHECK ("vat_amount" >= 0 AND "vat_amount" < "amount");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_refund_type_check" CHECK (("type" = 'credit_note') = ("refund_id" IS NOT NULL));
CREATE UNIQUE INDEX "invoices_one_tax_invoice_per_order" ON "invoices" ("order_id") WHERE "type" = 'tax_invoice_receipt';

-- VAT rate table (spec §3): a rate is a fraction, 0 ≤ rate < 1. The Israeli rate in force: 18% from 2025-01-01.
ALTER TABLE "vat_rates" ADD CONSTRAINT "vat_rates_rate_check" CHECK ("rate" >= 0 AND "rate" < 1);
INSERT INTO "vat_rates" ("rate", "effective_from") VALUES (0.18, '2025-01-01');

-- Running numbers of the `mock` invoice adapter (MOCK-INV-000001, MOCK-CN-000001).
CREATE SEQUENCE "mock_invoice_seq";
CREATE SEQUENCE "mock_credit_note_seq";
