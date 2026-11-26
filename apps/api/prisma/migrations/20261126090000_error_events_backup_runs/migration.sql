-- CreateEnum
CREATE TYPE "error_event_kind" AS ENUM ('error', 'warn');

-- CreateEnum
CREATE TYPE "error_event_source" AS ENUM ('api', 'ssr');

-- CreateEnum
CREATE TYPE "backup_kind" AS ENUM ('db', 'media', 'restore_test');

-- CreateTable
CREATE TABLE "error_events" (
    "id" SERIAL NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" "error_event_kind" NOT NULL,
    "source" "error_event_source" NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "path" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_seen" TIMESTAMP(3) NOT NULL,
    "last_seen" TIMESTAMP(3) NOT NULL,
    "handled_at" TIMESTAMP(3),
    "handled_by_id" INTEGER,
    "reopened_at" TIMESTAMP(3),
    "alerted_at" TIMESTAMP(3),

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" SERIAL NOT NULL,
    "kind" "backup_kind" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "ok" BOOLEAN,
    "bytes" BIGINT,
    "objects" INTEGER,
    "detail" TEXT,
    "alerted_at" TIMESTAMP(3),

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "error_events_fingerprint_key" ON "error_events"("fingerprint");

-- CreateIndex
CREATE INDEX "error_events_handled_at_last_seen_idx" ON "error_events"("handled_at", "last_seen" DESC);

-- CreateIndex
CREATE INDEX "error_events_handled_by_id_idx" ON "error_events"("handled_by_id");

-- CreateIndex
CREATE INDEX "backup_runs_kind_started_at_idx" ON "backup_runs"("kind", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

