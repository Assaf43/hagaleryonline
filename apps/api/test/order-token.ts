import { OrderTokens, orderTokenKey } from './../src/orders/order-token.js';
import type { PrismaService } from './../src/prisma/prisma.service.js';

/** The e2e API's key: ORDER_TOKEN_KEY when set, else the dev default (as `OrderTokensModule` builds it). */
export const testOrderTokens = () => new OrderTokens(orderTokenKey(process.env.NODE_ENV, process.env.ORDER_TOKEN_KEY));

/**
 * The token of an order's link (`/order/:number?t=`), as the e-mails carry it: new orders store it sealed only
 * (spec 9a.7), so tests read it through the same reveal as the API.
 */
export async function orderLinkToken(prisma: PrismaService, number: number): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { number },
    select: { publicToken: true, publicTokenSealed: true },
  });
  return testOrderTokens().reveal(order);
}

/** An order row's token columns as the API writes them now (spec 9a.7): sealed only, the plain column left null. */
export const sealedToken = (token: string) => ({ publicTokenSealed: testOrderTokens().seal(token) });
