import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { CartView, ProductDetail } from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { CartService } from './../src/cart/cart.service.js';
import { configureApp } from './../src/configure-app.js';
import { FulfillmentMode } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4200';
const ADMIN_ORIGIN = 'http://localhost:4300';
const DAY_MS = 24 * 60 * 60_000;

// Runs against the e2e test database, migrated and seeded by test/e2e-global-setup.ts (needs `npm run db:up`).
describe('Cart API (e2e, CRT-02, CRT-04)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  /** Test variants: in stock (3 left), made to order, out of stock. */
  let inStock: number;
  let madeToOrder: number;
  let outOfStock: number;

  /** A storefront browser: keeps cookies and sends the storefront's Origin. */
  const browser = () => {
    const agent = request.agent(app.getHttpServer());
    return {
      agent,
      get: () => agent.get('/api/cart'),
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }),
      patch: (variantId: number, quantity: number) =>
        agent.patch(`/api/cart/items/${variantId}`).set('Origin', ORIGIN).send({ quantity }),
      remove: (variantId: number) => agent.delete(`/api/cart/items/${variantId}`).set('Origin', ORIGIN),
    };
  };
  const view = (res: request.Response) => res.body as CartView;
  const cartCookie = (res: request.Response) =>
    ([res.headers['set-cookie'] ?? []].flat() as string[]).find((c) => c.startsWith('hg_cart='));
  const tokenOf = (cookie: string) => decodeURIComponent(cookie.split(';')[0].slice('hg_cart='.length));
  const hashOf = (cookie: string) => createHash('sha256').update(tokenOf(cookie)).digest('hex');
  const invalidateCatalog = () => app.get(CacheStore).invalidate('catalog:');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.cart.deleteMany();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZ' } } });
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'corner-sofas' } });
    const size = { widthCm: 280, depthCm: 95, heightCm: 85 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-cart-sofa',
        modelName: 'ZZCART',
        nameHe: 'ספת בדיקה',
        categoryId: sofas.id,
        variants: {
          create: [
            { sku: 'ZZCART-1', price: 100_000, stock: 3, leadTimeDays: 14, sortOrder: 0, ...size },
            {
              sku: 'ZZCART-2',
              price: 250_000,
              compareAtPrice: 300_000,
              fulfillment: FulfillmentMode.MADE_TO_ORDER,
              leadTimeDays: 45,
              sortOrder: 1,
              ...size,
            },
            {
              sku: 'ZZCART-3',
              price: 90_000,
              fulfillment: FulfillmentMode.OUT_OF_STOCK,
              leadTimeDays: 60,
              sortOrder: 2,
              ...size,
            },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    [inStock, madeToOrder, outOfStock] = product.variants.map((v) => v.id);
    await invalidateCatalog();
  });

  afterAll(async () => {
    await prisma.cart.deleteMany();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZ' } } });
    await invalidateCatalog();
    await app.close();
  });

  it('GET without a cookie returns an empty cart and creates nothing', async () => {
    const res = await browser().get().expect(200);
    expect(view(res)).toEqual({
      lines: [],
      itemCount: 0,
      subtotal: 0,
      deliveryEstimate: null,
      notices: [],
      shippingFrom: null,
      discount: null,
      couponCode: null,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await prisma.cart.count()).toBe(0);
  });

  it('POST creates the cart and sets the httpOnly hg_cart cookie; only its hash is stored', async () => {
    const b = browser();
    const res = await b.add(inStock, 1).expect(200);
    const cookie = cartCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);
    const token = tokenOf(cookie!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = createHash('sha256').update(token).digest('hex');
    expect(await prisma.cart.findUnique({ where: { tokenHash: hash } })).not.toBeNull();
    expect(await prisma.cart.findFirst({ where: { tokenHash: token } })).toBeNull();

    const cart = view(res);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({
      variantId: inStock,
      productSlug: 'zz-cart-sofa',
      modelName: 'ZZCART',
      nameHe: 'ספת בדיקה',
      unitPrice: 100_000,
      compareAtPrice: null,
      quantity: 1,
      lineTotal: 100_000,
      maxQuantity: 3,
      fulfillment: 'in_stock',
      leadTimeDays: 14,
      available: true,
      unavailableReason: null,
    });
    expect(cart).toMatchObject({ itemCount: 1, subtotal: 100_000, notices: [] });
    expect(cart.deliveryEstimate).toEqual({ fulfillment: 'in_stock', leadTimeDays: 14 });

    // The cookie is renewed on use.
    const read = await b.get().expect(200);
    expect(cartCookie(read)).toBeDefined();
    expect(view(read).itemCount).toBe(1);
  });

  it('POST of the same variant adds to the existing line', async () => {
    const b = browser();
    await b.add(inStock, 1).expect(200);
    const cart = view(await b.add(inStock, 1).expect(200));
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(2);
    expect(cart.subtotal).toBe(200_000);
  });

  it('clamps a quantity above the limit and says so', async () => {
    const b = browser();
    const cart = view(await b.add(inStock, 5).expect(200));
    expect(cart.lines[0].quantity).toBe(3);
    expect(cart.notices).toEqual([{ variantId: inStock, kind: 'quantity_clamped', messageHe: 'נשארו רק 3 במלאי' }]);

    const more = view(await b.add(madeToOrder, 12).expect(200));
    expect(more.lines.find((l) => l.variantId === madeToOrder)).toMatchObject({
      quantity: 10,
      maxQuantity: 10,
      compareAtPrice: 300_000,
    });
    expect(more.notices).toEqual([
      { variantId: madeToOrder, kind: 'quantity_clamped', messageHe: 'אפשר להזמין עד 10 יחידות' },
    ]);
    // The slowest line sets the delivery estimate (CRT-04).
    expect(more.deliveryEstimate).toEqual({ fulfillment: 'made_to_order', leadTimeDays: 45 });
    expect(more.itemCount).toBe(13);
    expect(more.subtotal).toBe(3 * 100_000 + 10 * 250_000);
  });

  it('clamps a stored line on read when the stock drops', async () => {
    const b = browser();
    await b.add(inStock, 3).expect(200);
    await prisma.variant.update({ where: { id: inStock }, data: { stock: 2 } });
    try {
      const cart = view(await b.get().expect(200));
      expect(cart.lines[0].quantity).toBe(2);
      expect(cart.notices).toEqual([{ variantId: inStock, kind: 'quantity_clamped', messageHe: 'נשארו רק 2 במלאי' }]);
    } finally {
      await prisma.variant.update({ where: { id: inStock }, data: { stock: 3 } });
    }
  });

  it('marks an in-stock line with nothing left as sold out', async () => {
    const b = browser();
    await b.add(inStock, 2).expect(200);
    await b.add(madeToOrder, 1).expect(200);
    await prisma.variant.update({ where: { id: inStock }, data: { stock: 0 } });
    try {
      const cart = view(await b.get().expect(200));
      expect(cart.lines.find((l) => l.variantId === inStock)).toMatchObject({
        available: false,
        unavailableReason: 'sold_out',
        quantity: 2,
        maxQuantity: 0,
      });
      expect(cart.notices).toEqual([{ variantId: inStock, kind: 'unavailable', messageHe: 'ZZCART אזל מהמלאי' }]);
      expect(cart.subtotal).toBe(250_000);
      expect(cart.itemCount).toBe(1);
      expect(cart.deliveryEstimate).toEqual({ fulfillment: 'made_to_order', leadTimeDays: 45 });
    } finally {
      await prisma.variant.update({ where: { id: inStock }, data: { stock: 3 } });
    }
  });

  it('does not lose quantity when two adds arrive together', async () => {
    const b = browser();
    const tokenHash = hashOf(cartCookie(await b.add(madeToOrder, 1).expect(200))!);
    await Promise.all([b.add(inStock, 1).expect(200), b.add(inStock, 1).expect(200)]);
    const cart = view(await b.get().expect(200));
    expect(cart.lines.find((l) => l.variantId === inStock)?.quantity).toBe(2);
    expect(
      await prisma.cartItem.findMany({ where: { cart: { tokenHash } }, select: { variantId: true, quantity: true } }),
    ).toEqual(expect.arrayContaining([{ variantId: inStock, quantity: 2 }]));
    expect(await prisma.cartItem.count({ where: { cart: { tokenHash } } })).toBe(2);
  });

  it('PATCH sets the quantity and DELETE removes the line', async () => {
    const b = browser();
    await b.add(inStock, 1).expect(200);
    await b.add(madeToOrder, 1).expect(200);

    const patched = view(await b.patch(madeToOrder, 4).expect(200));
    expect(patched.lines.find((l) => l.variantId === madeToOrder)?.quantity).toBe(4);
    expect(patched.itemCount).toBe(5);

    const clamped = view(await b.patch(inStock, 9).expect(200));
    expect(clamped.lines.find((l) => l.variantId === inStock)?.quantity).toBe(3);
    expect(clamped.notices.map((n) => n.kind)).toEqual(['quantity_clamped']);

    const removed = view(await b.remove(madeToOrder).expect(200));
    expect(removed.lines.map((l) => l.variantId)).toEqual([inStock]);

    await b.patch(madeToOrder, 1).expect(404);
  });

  it('rejects bad input, unknown variants and variants that cannot be ordered', async () => {
    const b = browser();
    await b.add(inStock, 0).expect(400);
    await b.add(inStock, 1.5).expect(400);
    await b.agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId: 'x', quantity: 1 }).expect(400);
    await b.add(999_999_999, 1).expect(404);
    for (const id of ['12abc', '1e3', '-1', '0x10', ' 5'])
      await b.agent
        .patch(`/api/cart/items/${encodeURIComponent(id)}`)
        .set('Origin', ORIGIN)
        .send({ quantity: 1 })
        .expect(400);
    await b.agent.delete('/api/cart/items/abc').set('Origin', ORIGIN).expect(400);
    const res = await b.add(outOfStock, 1).expect(409);
    expect(res.body.code).toBe('unavailable');
    // Nothing was added, so no cart exists yet.
    expect(cartCookie(res)).toBeUndefined();
  });

  it('shows a price change since the line was added', async () => {
    const b = browser();
    const tokenHash = hashOf(cartCookie(await b.add(inStock, 1).expect(200))!);
    await prisma.variant.update({ where: { id: inStock }, data: { price: 120_000 } });
    try {
      const cart = view(await b.get().expect(200));
      expect(cart.lines[0]).toMatchObject({ unitPrice: 120_000, lineTotal: 120_000 });
      expect(cart.subtotal).toBe(120_000);
      expect(cart.notices).toEqual([{ variantId: inStock, kind: 'price_changed', messageHe: 'המחיר של ZZCART עודכן' }]);
      // Shown once: the read takes the new price as the line's reference price.
      const again = view(await b.get().expect(200));
      expect(again.notices).toEqual([]);
      expect(again.lines[0].unitPrice).toBe(120_000);
      expect(
        (await prisma.cartItem.findFirstOrThrow({ where: { variantId: inStock, cart: { tokenHash } } })).unitPriceAtAdd,
      ).toBe(120_000);
    } finally {
      await prisma.variant.update({ where: { id: inStock }, data: { price: 100_000 } });
    }
  });

  it('marks a hidden product unavailable and leaves it out of the subtotal', async () => {
    const b = browser();
    await b.add(inStock, 1).expect(200);
    const albaVariant = await prisma.variant.findFirstOrThrow({
      where: {
        product: { slug: 'alba-corner-sofa' },
        active: true,
        fulfillment: { not: FulfillmentMode.OUT_OF_STOCK },
      },
      orderBy: { sortOrder: 'asc' },
    });
    const alba = view(await b.add(albaVariant.id, 1).expect(200)).lines.find((l) => l.variantId === albaVariant.id)!;
    // Option labels as the product page shows them: color, fabric, size, chaise side — and a photo.
    const page = (await request(app.getHttpServer()).get('/api/products/alba-corner-sofa').expect(200))
      .body as ProductDetail;
    const options = page.variants.find((v) => v.sku === albaVariant.sku)!.options;
    expect(page.optionAxes.map((a) => a.code)).toEqual(['color', 'fabric', 'size', 'chaise-side']);
    expect(alba.optionLabels).toEqual(
      page.optionAxes.map((axis) => axis.values.find((v) => v.code === options[axis.code])!.labelHe),
    );
    expect(alba.image).not.toBeNull();

    await prisma.product.update({ where: { slug: 'zz-cart-sofa' }, data: { active: false } });
    await invalidateCatalog();
    try {
      const cart = view(await b.get().expect(200));
      expect(cart.lines.find((l) => l.variantId === inStock)).toMatchObject({
        available: false,
        unavailableReason: 'hidden',
        modelName: 'ZZCART',
      });
      expect(cart.subtotal).toBe(albaVariant.price);
      expect(cart.itemCount).toBe(1);
      expect(cart.notices).toEqual([{ variantId: inStock, kind: 'unavailable', messageHe: 'ZZCART לא זמין יותר' }]);
      expect(cart.deliveryEstimate?.leadTimeDays).toBe(albaVariant.leadTimeDays);
      // The line can no longer be changed or added to, only removed.
      expect((await b.patch(inStock, 2).expect(409)).body.code).toBe('unavailable');
      await b.add(inStock, 1).expect(404);
      expect(view(await b.remove(inStock).expect(200)).lines.map((l) => l.variantId)).toEqual([albaVariant.id]);
    } finally {
      await prisma.product.update({ where: { slug: 'zz-cart-sofa' }, data: { active: true } });
      await invalidateCatalog();
    }
  });

  it('keeps the storefront and the admin app out of the other app write endpoints', async () => {
    const server = app.getHttpServer();
    const before = await prisma.cart.count();
    // The admin app's origin cannot write to the cart.
    await request(server)
      .post('/api/cart/items')
      .set('Origin', ADMIN_ORIGIN)
      .send({ variantId: inStock, quantity: 1 })
      .expect(403);
    expect(await prisma.cart.count()).toBe(before);
    // The storefront's origin cannot write to the admin API, whatever the path's case.
    const login = { email: 'nobody@example.test', password: 'x' };
    expect(
      (await request(server).post('/api/admin/auth/login').set('Origin', ORIGIN).send(login).expect(403)).body.code,
    ).toBe('forbidden');
    await request(server).post('/API/ADMIN/auth/login').set('Origin', ORIGIN).send(login).expect(403);
    await request(server).post('/Api/Admin/auth/login').set('Origin', ORIGIN).send(login).expect(403);
    // The storefront's origin can.
    await request(server)
      .post('/api/cart/items')
      .set('Origin', ORIGIN)
      .send({ variantId: inStock, quantity: 1 })
      .expect(200);
  });

  it('refuses cart writes from a foreign origin or without one (StorefrontOriginGuard)', async () => {
    const server = app.getHttpServer();
    const before = await prisma.cart.count();
    const foreign = await request(server)
      .post('/api/cart/items')
      .set('Origin', 'https://evil.example')
      .send({ variantId: inStock, quantity: 1 })
      .expect(403);
    expect(cartCookie(foreign)).toBeUndefined();
    await request(server).post('/api/cart/items').send({ variantId: inStock, quantity: 1 }).expect(403);
    await request(server).delete(`/api/cart/items/${inStock}`).set('Origin', 'https://evil.example').expect(403);
    expect(await prisma.cart.count()).toBe(before);
  });

  it('deletes carts unused for 30 days, on access and in the daily cleanup', async () => {
    const stale = new Date(Date.now() - 31 * DAY_MS);

    // On access: an expired cart reads as empty and is removed.
    const a = browser();
    const token = tokenOf(cartCookie(await a.add(inStock, 1).expect(200))!);
    const hash = createHash('sha256').update(token).digest('hex');
    await prisma.cart.update({ where: { tokenHash: hash }, data: { updatedAt: stale } });
    expect(view(await a.get().expect(200)).lines).toEqual([]);
    expect(await prisma.cart.findUnique({ where: { tokenHash: hash } })).toBeNull();

    // Daily cleanup.
    const b = browser();
    const old = tokenOf(cartCookie(await b.add(inStock, 1).expect(200))!);
    const oldHash = createHash('sha256').update(old).digest('hex');
    const c = browser();
    const fresh = tokenOf(cartCookie(await c.add(inStock, 1).expect(200))!);
    const freshHash = createHash('sha256').update(fresh).digest('hex');
    await prisma.cart.update({ where: { tokenHash: oldHash }, data: { updatedAt: stale } });

    await app.get(CartService).deleteStaleCarts();
    expect(await prisma.cart.findUnique({ where: { tokenHash: oldHash } })).toBeNull();
    expect(await prisma.cartItem.count({ where: { cart: { tokenHash: oldHash } } })).toBe(0);
    expect(await prisma.cart.findUnique({ where: { tokenHash: freshHash } })).not.toBeNull();
  });
});
