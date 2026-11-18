-- CreateEnum
CREATE TYPE "landing_status" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "landing_pages" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "title_he" TEXT NOT NULL,
    "subline_he" TEXT,
    "intro_html" TEXT NOT NULL,
    "outro_html" TEXT,
    "image_id" INTEGER NOT NULL,
    "mobile_image_id" INTEGER,
    "alt_he" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "status" "landing_status" NOT NULL DEFAULT 'draft',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "ended_link_url" TEXT NOT NULL DEFAULT '/',
    "meta_description_he" TEXT,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "landing_pages_slug_key" ON "landing_pages"("slug");

-- CreateIndex
CREATE INDEX "landing_pages_image_id_idx" ON "landing_pages"("image_id");

-- CreateIndex
CREATE INDEX "landing_pages_mobile_image_id_idx" ON "landing_pages"("mobile_image_id");

-- AddForeignKey
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "content_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_mobile_image_id_fkey" FOREIGN KEY ("mobile_image_id") REFERENCES "content_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

