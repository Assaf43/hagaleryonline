/**
 * Reference data: `npm run db:localities -w @hg/api` upserts the CBS localities list.
 * Idempotent and safe in production (the dev seed does not truncate it).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

interface LocalityRow {
  code: number;
  nameHe: string;
}

export async function seedLocalities(prisma: PrismaClient): Promise<number> {
  const rows = JSON.parse(
    readFileSync(fileURLToPath(new URL('./data/localities.json', import.meta.url)), 'utf8'),
  ) as LocalityRow[];
  const ids = rows.map((r) => r.code);
  const names = rows.map((r) => r.nameHe);
  await prisma.$executeRaw`
    INSERT INTO localities (id, name_he)
    SELECT * FROM unnest(${ids}::int[], ${names}::text[])
    ON CONFLICT (id) DO UPDATE SET name_he = EXCLUDED.name_he`;
  return rows.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  config({ path: '../../.env', quiet: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  seedLocalities(prisma)
    .then((n) => console.log(`Localities upserted: ${n}`))
    .finally(() => prisma.$disconnect());
}
