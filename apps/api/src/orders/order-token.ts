import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { randomToken, safeEqual, SecretBox } from '../auth/crypto.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The dev and test key of order tokens when ORDER_TOKEN_KEY is unset (32 bytes, base64 of
 * "dev-order-token-key-not-secret!!"). Never used in production, where the key is required.
 */
export const DEV_ORDER_TOKEN_KEY = 'ZGV2LW9yZGVyLXRva2VuLWtleS1ub3Qtc2VjcmV0ISE=';

/** ORDER_TOKEN_KEY: outside production the dev default stands in when it is empty; production must set it. */
export function orderTokenKey(nodeEnv: string | undefined, value: string | undefined): string {
  if (nodeEnv === 'production') return value ?? '';
  return value || DEV_ORDER_TOKEN_KEY;
}

/**
 * How an order keeps the token of its link (`/order/:number?t=`): new orders hold it AES-256-GCM sealed only
 * (`public_token_sealed`, spec 9a.7); orders placed before keep the plain value (`public_token`) until the
 * `seal-order-tokens` CLI seals it. The SQL CHECK `orders_public_token_present` keeps at least one of the two.
 */
export type OrderTokenFields = { publicToken: string | null; publicTokenSealed: string | null };

/** The columns to `select` wherever an order's token is read. */
export const ORDER_TOKEN_FIELDS = { publicToken: true, publicTokenSealed: true } as const satisfies Prisma.OrderSelect;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Issues, reveals and checks order link tokens. Every lookup has the order number first (the order page, its
 * invoices, payment returns, the status lookup), so the stored token is decrypted and compared — no lookup by token.
 * The token is never logged.
 */
@Injectable()
export class OrderTokens {
  private readonly box: SecretBox;

  constructor(base64Key: string) {
    this.box = new SecretBox(base64Key, 'ORDER_TOKEN_KEY');
  }

  /** A new order's token and the sealed value to store (`publicTokenSealed`; `publicToken` stays null). */
  issue(): { token: string; sealed: string } {
    const token = randomToken();
    return { token, sealed: this.seal(token) };
  }

  seal(token: string): string {
    return this.box.encrypt(token);
  }

  /** The token of the order's link: the sealed value decrypted, else the legacy plain one. Throws when unreadable. */
  reveal(order: OrderTokenFields): string {
    if (order.publicTokenSealed !== null) return this.box.decrypt(order.publicTokenSealed);
    if (order.publicToken !== null) return order.publicToken;
    throw new Error('Order has no token');
  }

  /**
   * Whether the URL token is the order's, in constant time (both hashed to equal length first). A missing or empty
   * token, an unreadable sealed value (wrong key, tampered) or an order without a token → false.
   */
  matches(given: string | undefined, order: OrderTokenFields): boolean {
    if (!given) return false;
    let expected: string;
    try {
      expected = this.reveal(order);
    } catch {
      return false;
    }
    return expected.length > 0 && safeEqual(digest(given), digest(expected));
  }
}

/** Rows read and sealed per round of `sealOrderTokens`. */
const SEAL_BATCH = 500;

/**
 * The `seal-order-tokens` CLI: seals every legacy plain token (`public_token_sealed` set, `public_token` cleared) in
 * batches. Idempotent: a sealed row is never read again, and a row whose plain token changed meanwhile is left for the
 * next run. Old links keep working (the same token, now sealed). Returns how many rows it sealed.
 */
export async function sealOrderTokens(prisma: PrismaService, tokens: OrderTokens): Promise<number> {
  let sealed = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.order.findMany({
      where: { publicToken: { not: null }, ...(after === undefined ? {} : { id: { gt: after } }) },
      select: { id: true, publicToken: true },
      orderBy: { id: 'asc' },
      take: SEAL_BATCH,
    });
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      const plain = row.publicToken!;
      sealed += await prisma.$executeRaw`UPDATE orders SET public_token_sealed = ${tokens.seal(plain)},
        public_token = NULL WHERE id = ${row.id}::uuid AND public_token = ${plain}`;
    }
    after = rows[rows.length - 1].id;
  }
}
