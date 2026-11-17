-- CreateTable
CREATE TABLE "site_content" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "support_phone" TEXT NOT NULL,
    "support_email" TEXT NOT NULL,
    "whatsapp" TEXT NOT NULL,
    "shipping_html" TEXT NOT NULL,
    "interim" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" SERIAL NOT NULL,
    "text_he" TEXT NOT NULL,
    "link_url" TEXT,
    "link_label_he" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "info_pages" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "system_key" TEXT,
    "title_he" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "meta_description_he" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "show_in_footer" BOOLEAN NOT NULL DEFAULT false,
    "footer_label_he" TEXT,
    "footer_order" INTEGER NOT NULL DEFAULT 0,
    "interim" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "info_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_groups" (
    "id" SERIAL NOT NULL,
    "title_he" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_items" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "question_he" TEXT NOT NULL,
    "answer_html" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_active_sort_order_idx" ON "announcements"("active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "info_pages_slug_key" ON "info_pages"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "info_pages_system_key_key" ON "info_pages"("system_key");

-- CreateIndex
CREATE INDEX "faq_items_group_id_sort_order_idx" ON "faq_items"("group_id", "sort_order");

-- AddForeignKey
ALTER TABLE "faq_items" ADD CONSTRAINT "faq_items_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "faq_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Site details: one row only (spec §4.4).
ALTER TABLE "site_content" ADD CONSTRAINT "site_content_single_row" CHECK ("id" = 1);

-- Decision 100: today's interim texts move into the CMS (marked interim until an editor saves them). Production gets
-- these rows from this migration, never from db:seed. No FAQ rows and no announcement.
INSERT INTO "site_content" ("id", "support_phone", "support_email", "whatsapp", "shipping_html", "interim", "updated_at")
VALUES (1, '03-0000000', 'service@example.test', '972000000000', '<p>משלוח עד הבית בלבד, לכל הארץ.</p><p>אפשר לבחור משלוח עד נקודת הפריקה, או משלוח שכולל הובלה לתוך הבית והרכבה. המחיר מחושב בקופה, לפי המוצר, הקומה והאם יש מעלית.</p><p>זמן האספקה מופיע בעמוד המוצר ותלוי בדגם ובצבע שבחרתם.</p><p>ביטול עסקה והחזרות לפי חוק הגנת הצרכן. פרטים מלאים יופיעו בעמוד מדיניות ההחזרות.</p>', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- System info pages (systemKey = slug): published, noindex while interim, in the footer "מידע ושירות" column.
INSERT INTO "info_pages" ("slug", "system_key", "title_he", "body_html", "meta_description_he", "published", "noindex", "show_in_footer", "footer_label_he", "footer_order", "interim", "updated_at")
VALUES
  ('shipping', 'shipping', 'משלוחים', '<p>משלוח עד הבית בלבד, לכל הארץ.</p><p>אפשר לבחור משלוח עד נקודת הפריקה, או משלוח שכולל הובלה לתוך הבית והרכבה. המחיר מחושב בקופה, לפי המוצר, הקומה והאם יש מעלית.</p><p>זמן האספקה מופיע בעמוד המוצר ותלוי בדגם ובצבע שבחרתם.</p><p>ביטול עסקה והחזרות לפי חוק הגנת הצרכן. פרטים מלאים יופיעו בעמוד מדיניות ההחזרות.</p>', NULL, true, true, true, 'משלוחים', 1, true, CURRENT_TIMESTAMP),
  ('returns', 'returns', 'מדיניות החזרות', '<p>טקסט זמני. הנוסח הסופי יפורסם בקרוב.</p>', NULL, true, true, true, 'מדיניות החזרות', 2, true, CURRENT_TIMESTAMP),
  ('warranty', 'warranty', 'אחריות', '<p>טקסט זמני. הנוסח הסופי יפורסם בקרוב.</p>', NULL, true, true, true, 'אחריות', 3, true, CURRENT_TIMESTAMP),
  ('terms', 'terms', 'תנאי שימוש', '<p>ברוכים הבאים לאתר. השימוש באתר ורכישה בו כפופים לתנאים שלהלן. זהו נוסח זמני, והנוסח המלא יפורסם בקרוב.</p><h2>רכישה באתר</h2><p>המחירים באתר הם בשקלים וכוללים מע״מ. מחיר המשלוח מחושב לפי הכתובת ושיטת המשלוח שבחרתם ומוצג לפני התשלום.</p><p>ההזמנה נקלטת לאחר אישור התשלום בעמוד המאובטח של חברת הסליקה. פרטי כרטיס האשראי אינם נשמרים אצלנו.</p><p>המוצרים שמורים עבורכם 20 דקות מרגע המעבר לתשלום. אם התשלום לא הושלם בזמן הזה, ייתכן שהמוצרים כבר לא יהיו זמינים.</p><h2>משלוח ומסירה</h2><p>המשלוח הוא עד הבית בלבד. זמן האספקה המשוער מוצג בסל ובעמוד ההזמנה, ונציג יתאם אתכם את מועד המסירה.</p><p>במשלוח "עד נקודת הפריקה" המוצר נמסר בנקודת הפריקה הקרובה לבית. במשלוח "כולל סבלות והרכבה" המוצר מועלה לדירה ומורכב בה.</p><h2>ביטול עסקה והחזרות</h2><p>ביטול עסקה והחזרת מוצרים נעשים לפי חוק הגנת הצרכן, התשמ״א־1981, ותקנות הגנת הצרכן (ביטול עסקה), התשע״א־2010.</p><p>מוצר שיוצר או הותאם במיוחד עבורכם אינו ניתן לביטול לפי החוק. פרטים מלאים על אופן הביטול ודמי הביטול יפורסמו בקרוב.</p><h2>פרטיות</h2><p>הפרטים שתמסרו בהזמנה (שם, טלפון, דוא״ל וכתובת) משמשים לביצוע ההזמנה, למשלוח ולשירות בלבד. מדיניות הפרטיות המלאה תפורסם בקרוב.</p>', 'תנאי הרכישה באתר: הזמנה, משלוח, ביטול עסקה והחזרות ופרטיות.', true, true, true, 'תקנון', 4, true, CURRENT_TIMESTAMP),
  ('privacy', 'privacy', 'מדיניות פרטיות', '<p>טקסט זמני. הנוסח הסופי יפורסם בקרוב.</p>', NULL, true, true, true, 'פרטיות', 5, true, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
