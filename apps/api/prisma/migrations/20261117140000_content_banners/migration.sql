-- CreateTable
CREATE TABLE "content_images" (
    "id" SERIAL NOT NULL,
    "storage_key" TEXT NOT NULL,
    "widths" INTEGER[],
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "original_ext" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banners" (
    "id" SERIAL NOT NULL,
    "name_he" TEXT NOT NULL,
    "headline_he" TEXT NOT NULL,
    "subline_he" TEXT,
    "cta_label_he" TEXT,
    "link_url" TEXT NOT NULL,
    "image_id" INTEGER NOT NULL,
    "mobile_image_id" INTEGER,
    "alt_he" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_images_storage_key_key" ON "content_images"("storage_key");

-- CreateIndex
CREATE INDEX "banners_image_id_idx" ON "banners"("image_id");

-- CreateIndex
CREATE INDEX "banners_mobile_image_id_idx" ON "banners"("mobile_image_id");

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "content_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banners" ADD CONSTRAINT "banners_mobile_image_id_fkey" FOREIGN KEY ("mobile_image_id") REFERENCES "content_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

