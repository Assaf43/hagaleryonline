-- CreateTable
CREATE TABLE "localities" (
    "id" INTEGER NOT NULL,
    "name_he" TEXT NOT NULL,

    CONSTRAINT "localities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "localities_name_he_idx" ON "localities"("name_he");
