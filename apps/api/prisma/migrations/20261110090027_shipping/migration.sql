-- CreateTable
CREATE TABLE "shipping_rates" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER,
    "delivery_price" INTEGER NOT NULL,
    "assembly_price" INTEGER NOT NULL,

    CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "additional_item_percent" INTEGER NOT NULL DEFAULT 50,
    "floor_surcharge" INTEGER NOT NULL,
    "floor_surcharge_from" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "shipping_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_zones" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "surcharge" INTEGER NOT NULL,

    CONSTRAINT "shipping_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zone_localities" (
    "zone_id" INTEGER NOT NULL,
    "locality_id" INTEGER NOT NULL,

    CONSTRAINT "zone_localities_pkey" PRIMARY KEY ("zone_id","locality_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_rates_category_id_key" ON "shipping_rates"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "zone_localities_locality_id_key" ON "zone_localities"("locality_id");

-- AddForeignKey
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_localities" ADD CONSTRAINT "zone_localities_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "shipping_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_localities" ADD CONSTRAINT "zone_localities_locality_id_fkey" FOREIGN KEY ("locality_id") REFERENCES "localities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
