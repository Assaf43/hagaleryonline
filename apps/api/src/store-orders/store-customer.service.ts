import { HttpStatus, Injectable } from '@nestjs/common';
import { CHECKOUT_LIMITS, type CustomerAddressView, type StoreCodeChannel, type StoreCustomerLookup } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CartError } from '../cart/cart.service.js';
import {
  AccountError,
  accountNotFound,
  badField,
  emailTaken,
  invalidCode,
  phoneTaken,
  tooManyRequests,
} from '../customers/account-errors.js';
import { listAddresses } from '../customers/address-view.js';
import { normalizeEmail, normalizePhone } from '../customers/contact-normalize.js';
import { OtpService } from '../customers/otp.service.js';
import { CustomerOrigin, Prisma, type Customer } from '../generated/prisma/client.js';
import { maskEmail } from '../notifications/masking.js';
import { customerNotConfirmed } from '../orders/order-errors.js';
import { THROTTLE_RETRY_AFTER_SECONDS, WriteThrottle } from '../orders/write-throttle.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StoreCartService } from './store-cart.service.js';
import { isConfirmationLive } from './store-confirmation.js';

export const STORE_CUSTOMER_CONFIRMED = 'store.customer_confirmed';
export const STORE_CUSTOMER_CREATED = 'customer.created_in_store';
export const STORE_CUSTOMER_EMAIL_ADDED = 'store.customer_email_added';
export const STORE_CUSTOMER_CLEARED = 'store.customer_cleared';
/**
 * Every store-tablet code, for an existing account or a new phone: a purpose no website endpoint accepts, so a code
 * heard at the store never signs in or starts a sign-up on the website, and a website code never confirms here.
 */
const STORE_OTP_PURPOSE = 'store_confirm';

/**
 * A code request or check from the seller screen, validated and normalized. Exactly one key: the customer's `phone`,
 * or `accountEmail` — the verified e-mail of an existing account (channel `email`, no new-customer details).
 */
export type StoreCodeInput = StoreCodeFields &
  ({ phone: string; accountEmail?: never } | { phone?: never; accountEmail: string });

interface StoreCodeFields {
  channel: StoreCodeChannel;
  /** Trimmed, single-spaced; present only when the seller typed it. */
  fullName?: string;
  email?: string;
}

export type StoreVerifyInput = StoreCodeInput & { code: string };

/** Who acts: the signed-in seller (the audit actor) and the request's IP (audit only, never a throttle key). */
export interface SellerActor {
  sellerId: number;
  ip?: string | null;
}

type BodyRecord = Record<string, unknown>;
const record = (body: unknown): BodyRecord =>
  body && typeof body === 'object' && !Array.isArray(body) ? (body as BodyRecord) : {};

/**
 * 400 for a malformed phone / e-mail key (exactly one of the two), channel, `newCustomer` or code; the checks that
 * need the database come later.
 */
export function parseStoreCodeInput(body: unknown): StoreCodeInput {
  const b = record(body);
  const given = (v: unknown) => v !== undefined && v !== null;
  if (given(b.email)) {
    if (given(b.phone)) throw badField('email');
    const accountEmail = normalizeEmail(b.email);
    if (!accountEmail) throw badField('email');
    if (b.channel !== 'email') throw badField('channel');
    if (given(b.newCustomer)) throw badField('newCustomer');
    return { accountEmail, channel: 'email' };
  }
  const phone = normalizePhone(b.phone);
  if (!phone) throw badField('phone');
  if (b.channel !== 'sms' && b.channel !== 'email') throw badField('channel');
  const input: StoreCodeInput = { phone, channel: b.channel };
  if (b.newCustomer === undefined || b.newCustomer === null) return input;
  if (typeof b.newCustomer !== 'object' || Array.isArray(b.newCustomer)) throw badField('newCustomer');
  const n = b.newCustomer as BodyRecord;
  if (n.fullName !== undefined && n.fullName !== null && n.fullName !== '') {
    const fullName = typeof n.fullName === 'string' ? n.fullName.trim().replace(/\s+/g, ' ') : '';
    if (fullName.length < CHECKOUT_LIMITS.fullNameMin || fullName.length > CHECKOUT_LIMITS.fullNameMax)
      throw badField('newCustomer.fullName');
    input.fullName = fullName;
  }
  const email = normalizeEmail(n.email);
  if (!email) throw badField('newCustomer.email');
  input.email = email;
  return input;
}

export function parseStoreVerifyInput(body: unknown): StoreVerifyInput {
  const input = parseStoreCodeInput(body);
  const { code } = record(body);
  // Any short string: the code check itself refuses anything but 6 digits (and spends no attempt on it).
  if (typeof code !== 'string' || code.length === 0 || code.length > 16) throw badField('code');
  return { ...input, code: code.trim() };
}

const emailNotVerified = () => new AccountError(HttpStatus.CONFLICT, 'email_not_verified', { field: 'channel' });
const notFound = () => new CartError(HttpStatus.NOT_FOUND, 'not_found');

/** Where a code goes and with which purpose, decided from the account the phone has now. */
type Plan =
  | { kind: 'existing'; customer: Customer; target: string; addEmail: string | null }
  | { kind: 'new'; phone: string; fullName: string; email: string };

/**
 * The customer at the store tablet proves who they are with a one-time code (spec §4.1 step 2, §4.3, decision 85).
 * An existing account: a code to its phone or its verified e-mail — found by the phone, or by that verified e-mail
 * itself (the `email` key: a new phone whose e-mail is the customer's own older account). A new phone: one SMS code,
 * then a quick account
 * (phone verified, e-mail not). Every code has the purpose `store_confirm`. A confirmed customer is held on the seller's open cart
 * (`storeCustomerId`); no customer session is created and no cookie is set.
 *
 * Code requests, lookups and checks count per seller (`store_otp` / `store_lookup` / `store_verify`, `seller:<id>`),
 * never per IP: the store has one public IP. The
 * per-target limit of `OtpService` (3 codes / 10 minutes) and its 5 attempts per code stay. Audit entries carry ids
 * and the channel only, never a code or a hash.
 */
@Injectable()
export class StoreCustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly throttle: WriteThrottle,
    private readonly storeCarts: StoreCartService,
    private readonly audit: AuditService,
  ) {}

  /** Whether the phone has an account, and the masked e-mail the seller may offer (per-seller limit `store_lookup`). */
  async lookup(actor: SellerActor, phone: string): Promise<StoreCustomerLookup> {
    if (!this.throttle.allow('store_lookup', `seller:${actor.sellerId}`))
      throw tooManyRequests(THROTTLE_RETRY_AFTER_SECONDS);
    await this.ensureCart(actor);
    const customer = await this.prisma.customer.findUnique({ where: { phone } });
    if (!customer) return { exists: false };
    return {
      exists: true,
      fullName: customer.fullName,
      maskedEmail: customer.email ? maskEmail(customer.email) : null,
      emailVerified: customer.email !== null && customer.emailVerifiedAt !== null,
    };
  }

  /**
   * Sends a code. Counted against the seller before any 409 check, so those checks are no unthrottled oracle. Over
   * the per-target limit the request is dropped silently (the answer is the same 204).
   */
  async requestCode(actor: SellerActor, input: StoreCodeInput): Promise<void> {
    if (!this.throttle.allow('store_otp', `seller:${actor.sellerId}`))
      throw tooManyRequests(THROTTLE_RETRY_AFTER_SECONDS);
    await this.ensureCart(actor);
    const plan = await this.plan(input, false);
    // No IP: the store's one address must not count against the website's per-IP code limit.
    const target = plan.kind === 'existing' ? plan.target : plan.phone;
    await this.otp.request(target, input.channel, STORE_OTP_PURPOSE, undefined, { ipChecked: true });
  }

  /**
   * Checks the code and attaches the customer to the seller's open cart (created when there is none); a new phone
   * gets its quick account in the same transaction. Every refusal that needs no code comes before the check, so it
   * spends no attempt. Returns the cart id.
   */
  async verify(actor: SellerActor, input: StoreVerifyInput): Promise<string> {
    // Counted first, on every call: the refusals below (400 / 409 / 401) would otherwise tell, without a limit,
    // whether a phone has an account or an e-mail is taken.
    if (!this.throttle.allow('store_verify', `seller:${actor.sellerId}`))
      throw tooManyRequests(THROTTLE_RETRY_AFTER_SECONDS);
    const plan = await this.plan(input, true);
    const target = plan.kind === 'existing' ? plan.target : plan.phone;
    const row = await this.otp.check(target, STORE_OTP_PURPOSE, input.code);
    if (!row) throw invalidCode();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cart = await this.storeCarts.openOrStartInTx(tx, actor.sellerId);
        if (cart.created) await this.recordStart(actor, cart.id, tx);
        const customerId =
          plan.kind === 'existing'
            ? await this.confirmExisting(tx, actor, plan, input.channel)
            : await this.createQuickAccount(tx, actor, plan);
        await tx.cart.update({
          where: { id: cart.id },
          data: { storeCustomerId: customerId, storeConfirmedAt: new Date() },
        });
        await this.audit.record(
          {
            actorId: actor.sellerId,
            action: STORE_CUSTOMER_CONFIRMED,
            entityType: 'cart',
            entityId: cart.id,
            after: { customerId, channel: input.channel },
            ip: actor.ip,
          },
          tx,
        );
        return cart.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Taken between the check and the write: say which.
        if (plan.kind === 'new' && (await this.prisma.customer.count({ where: { phone: plan.phone } })) > 0)
          throw phoneTaken();
        throw emailTaken();
      }
      throw error;
    }
  }

  /** Drops the attached customer from the seller's open cart; 404 when there is no open cart. Returns the cart id. */
  async clear(actor: SellerActor): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const open = await this.storeCarts.openIfAnyInTx(tx, actor.sellerId);
      if (!open) throw notFound();
      const cart = await tx.cart.findUniqueOrThrow({
        where: { id: open.id },
        select: { id: true, storeCustomerId: true },
      });
      if (cart.storeCustomerId === null) return cart.id;
      await tx.cart.update({ where: { id: cart.id }, data: { storeCustomerId: null, storeConfirmedAt: null } });
      await this.audit.record(
        {
          actorId: actor.sellerId,
          action: STORE_CUSTOMER_CLEARED,
          entityType: 'cart',
          entityId: cart.id,
          before: { customerId: cart.storeCustomerId },
          ip: actor.ip,
        },
        tx,
      );
      return cart.id;
    });
  }

  /**
   * The saved addresses of the customer confirmed on the seller's open cart (the delivery step's prefill), default
   * first; 409 `customer_not_confirmed` when there is no open cart or no live confirmation.
   */
  async addresses(sellerId: number): Promise<CustomerAddressView[]> {
    const open = await this.storeCarts.open(sellerId);
    const cart =
      open &&
      (await this.prisma.cart.findUnique({
        where: { id: open.id },
        select: { storeCustomerId: true, storeConfirmedAt: true, updatedAt: true },
      }));
    if (!cart?.storeCustomerId || !isConfirmationLive(cart)) throw customerNotConfirmed();
    return listAddresses(this.prisma, cart.storeCustomerId);
  }

  // ---------- Helpers ----------

  /** The customer endpoints open the seller's cart when there is none (audited as a new sale). */
  private async ensureCart(actor: SellerActor): Promise<void> {
    const cart = await this.storeCarts.openOrStart(actor.sellerId);
    if (cart.created) await this.recordStart(actor, cart.id);
  }

  private recordStart(actor: SellerActor, cartId: string, tx?: Prisma.TransactionClient): Promise<void> {
    return this.audit.record(
      { actorId: actor.sellerId, action: 'store_cart.start', entityType: 'cart', entityId: cartId, ip: actor.ip },
      tx,
    );
  }

  /**
   * Decides from the account the phone (or the `email` key) has now (it may have changed since the lookup):
   *  - the `email` key: the account whose e-mail it is, only while that e-mail is verified; an unknown and an
   *    unverified e-mail both answer 404 `not_found`, by one query (no `email_not_verified` through this key);
   *  - existing: the e-mail channel needs a verified e-mail (409 `email_not_verified`); an account without an e-mail
   *    must get one at the check (`newCustomer.email`, free, saved unverified; optional, but checked, at the request);
   *  - new: `newCustomer` with name and e-mail, SMS only, and an e-mail no other account holds. An e-mail held only
   *    unverified is not released here (only a verified website sign-up releases one): 409 `email_taken`.
   */
  private async plan(input: StoreCodeInput, checking: boolean): Promise<Plan> {
    if (input.accountEmail !== undefined) {
      const holder = await this.prisma.customer.findUnique({
        where: { email: input.accountEmail, emailVerifiedAt: { not: null } },
      });
      if (!holder?.email) throw accountNotFound();
      return { kind: 'existing', customer: holder, target: holder.email, addEmail: null };
    }
    const customer = await this.prisma.customer.findUnique({ where: { phone: input.phone } });
    if (customer) {
      let target = input.phone;
      if (input.channel === 'email') {
        if (!customer.email || !customer.emailVerifiedAt) throw emailNotVerified();
        target = customer.email;
      }
      let addEmail: string | null = null;
      if (!customer.email && !input.email && checking) throw badField('newCustomer.email');
      if (!customer.email && input.email) {
        await this.assertEmailFree(input.email, customer.id);
        addEmail = input.email;
      }
      return { kind: 'existing', customer, target, addEmail };
    }
    if (!input.fullName || !input.email) throw badField(input.email ? 'newCustomer.fullName' : 'newCustomer');
    if (input.channel !== 'sms') throw badField('channel');
    await this.assertEmailFree(input.email);
    return { kind: 'new', phone: input.phone, fullName: input.fullName, email: input.email };
  }

  /** Marks the channel verified (as sign-in does) and saves a missing e-mail, unverified. */
  private async confirmExisting(
    tx: Prisma.TransactionClient,
    actor: SellerActor,
    plan: Extract<Plan, { kind: 'existing' }>,
    channel: StoreCodeChannel,
  ): Promise<string> {
    const { customer } = plan;
    const data: Prisma.CustomerUpdateInput = {};
    if (channel === 'sms' && !customer.phoneVerifiedAt) data.phoneVerifiedAt = new Date();
    if (plan.addEmail) {
      // Only while the account still has no e-mail: one added meanwhile is kept.
      const added = await tx.customer.updateMany({
        where: { id: customer.id, email: null },
        data: { email: plan.addEmail, emailVerifiedAt: null },
      });
      if (added.count === 1)
        await this.audit.record(
          {
            actorId: actor.sellerId,
            action: STORE_CUSTOMER_EMAIL_ADDED,
            entityType: 'customer',
            entityId: customer.id,
            after: { customerId: customer.id },
            ip: actor.ip,
          },
          tx,
        );
    }
    if (Object.keys(data).length > 0) await tx.customer.update({ where: { id: customer.id }, data });
    return customer.id;
  }

  /** The quick account (decision 85): phone verified by this code, e-mail unverified, no password. */
  private async createQuickAccount(
    tx: Prisma.TransactionClient,
    actor: SellerActor,
    plan: Extract<Plan, { kind: 'new' }>,
  ): Promise<string> {
    const created = await tx.customer.create({
      data: {
        fullName: plan.fullName,
        phone: plan.phone,
        phoneVerifiedAt: new Date(),
        email: plan.email,
        emailVerifiedAt: null,
        passwordHash: null,
        createdVia: CustomerOrigin.STORE,
        createdBySellerId: actor.sellerId,
      },
      select: { id: true },
    });
    await this.audit.record(
      {
        actorId: actor.sellerId,
        action: STORE_CUSTOMER_CREATED,
        entityType: 'customer',
        entityId: created.id,
        after: { customerId: created.id },
        ip: actor.ip,
      },
      tx,
    );
    return created.id;
  }

  /** 409 `email_taken` when another account holds the e-mail, verified or not (no release from the store). */
  private async assertEmailFree(email: string, exceptId?: string): Promise<void> {
    const holder = await this.prisma.customer.findFirst({
      where: { email, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (holder) throw emailTaken();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
