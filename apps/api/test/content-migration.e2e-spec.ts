import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Phase 8 decision 100: the interim texts move into the CMS by a data migration (never by db:seed).
// The e2e database is kept between runs and later content tests edit these rows, so only what an editor can never
// change is asserted here: the one site-content row and the five system pages (key, slug, published).
describe('Content migration (e2e, SRV-04, decision 100)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    close = () => app.close();
  });
  afterAll(async () => close());

  it('has the one site-content row', async () => {
    const rows = await prisma.siteContent.findMany({ select: { id: true } });
    expect(rows).toEqual([{ id: 1 }]);
  });

  it('allows only the one site-content row', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO site_content (id, support_phone, support_email, whatsapp, shipping_html, updated_at)
        VALUES (2, 'x', 'x', '1', '', now())`,
    ).rejects.toThrow();
  });

  it('has the five published system info pages, each with its slug as key', async () => {
    const pages = await prisma.infoPage.findMany({
      where: { systemKey: { not: null } },
      select: { systemKey: true, slug: true, published: true },
      orderBy: { systemKey: 'asc' },
    });
    expect(pages).toEqual(
      ['privacy', 'returns', 'shipping', 'terms', 'warranty'].map((key) => ({
        systemKey: key,
        slug: key,
        published: true,
      })),
    );
  });
});
