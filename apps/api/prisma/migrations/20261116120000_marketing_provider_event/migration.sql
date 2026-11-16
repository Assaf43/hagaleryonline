-- AlterTable
ALTER TABLE "marketing_consent_events" ADD COLUMN     "provider_event_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consent_events_provider_event_id_key" ON "marketing_consent_events"("provider_event_id");

