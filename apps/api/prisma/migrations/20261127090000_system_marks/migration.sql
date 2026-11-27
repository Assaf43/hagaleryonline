-- CreateTable
CREATE TABLE "system_marks" (
    "key" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_marks_pkey" PRIMARY KEY ("key")
);
