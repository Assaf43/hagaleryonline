import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Phase 7 §5.3: consent lives in `marketing_contacts` with an append-only history; the customer columns are gone.
describe('Marketing tables (e2e, CLB-02, decision 95)', () => {
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

  it('has no marketing columns on customers any more, and orders keep theirs', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE 'marketing%'`;
    expect(rows.filter((r) => r.table_name === 'customers')).toEqual([]);
    expect(rows.filter((r) => r.table_name === 'orders').map((r) => r.column_name)).toContain('marketing_consent');
  });

  it('has the contacts and consent events tables with their unique indexes', async () => {
    const indexes = await prisma.$queryRaw<{ tablename: string; indexdef: string }[]>`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('marketing_contacts', 'marketing_consent_events')`;
    const unique = (col: string) =>
      indexes.some(
        (i) => i.tablename === 'marketing_contacts' && i.indexdef.includes('UNIQUE') && i.indexdef.includes(`(${col})`),
      );
    expect(unique('email')).toBe(true);
    expect(unique('customer_id')).toBe(true);
    expect(unique('confirm_token_hash')).toBe(true);
    expect(unique('unsubscribe_token_hash')).toBe(true);
    expect(
      indexes.some((i) => i.tablename === 'marketing_consent_events' && i.indexdef.includes('(contact_id, at)')),
    ).toBe(true);
  });
});
