import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { AccountBenefit, AccountBenefitStatus, IssuedPersonalCode, PersonalCodeSend } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { invalid, notFound } from '../catalog-admin/catalog-errors.js';
import { PromotionKind as DbPromotionKind, type Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { issuePersonalCode } from './personal-codes.js';
import { hasPaidOrder, welcomeTemplateWhere } from './promotions.service.js';

/** The audit action of a code issued by staff; its entry carries the template id only, never the code. */
export const CODE_ISSUED_ACTION = 'customer.code_issued';

/** How a welcome code reaches a new account: its verified e-mail (website sign-up) or phone (store quick account). */
export type WelcomeChannel = 'email' | 'sms';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND: readonly PersonalCodeSend[] = ['none', 'email', 'sms'];

const emailNotVerified = () =>
  new HttpException(
    { statusCode: HttpStatus.CONFLICT, code: 'email_not_verified', field: 'send' },
    HttpStatus.CONFLICT,
  );

/** The body of `POST /api/admin/customers/:id/codes`, validated: 400 `invalid` with the field otherwise. */
export function parseIssueInput(body: unknown): { templateId: number; send: PersonalCodeSend } {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { templateId, send } = b;
  if (typeof templateId !== 'number' || !Number.isInteger(templateId) || templateId < 1) throw invalid('templateId');
  if (typeof send !== 'string' || !SEND.includes(send as PersonalCodeSend)) throw invalid('send');
  return { templateId, send: send as PersonalCodeSend };
}

/**
 * Issuing personal codes (decisions 93–94, spec §4.1, §4.3, §5.2) and the account's "ההטבות שלי" list.
 *
 * - The welcome code is issued inside the transaction that creates the account (website sign-up, store quick
 *   account), when an active welcome template is inside its dates; no template → no code and no message.
 * - Staff issue a code from any active template (`club.manage`), optionally sent by e-mail or SMS; audited
 *   `customer.code_issued` with the template id only.
 *
 * Messages go through the outbox; a job carries only the code's id (`personalCodeId`), and the handler reads the code
 * when it sends (`notifications/personal-code-messages.job.ts`), so no code is ever in a job payload, audit entry or
 * log line. Issuing takes no lock (a plain read of the template and an insert), so it fits anywhere in the lock order;
 * call it before the marketing lock, which is always the last one.
 */
@Injectable()
export class PersonalCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The welcome code of a new account, in the caller's (account-creation) transaction, and its `<channel>.welcome_code`
   * message job (dedupe key `welcome_code:<codeId>`). Returns the code, or null when no welcome template is active.
   */
  async issueWelcome(
    tx: Prisma.TransactionClient,
    customerId: string,
    channel: WelcomeChannel,
    now = new Date(),
  ): Promise<string | null> {
    const template = await tx.promotion.findFirst({ where: welcomeTemplateWhere(now), select: { id: true } });
    if (!template) return null;
    const issued = await issuePersonalCode(tx, { templateId: template.id, customerId, issuedById: null, now });
    await this.outbox.enqueue(tx, {
      type: channel === 'email' ? 'email.welcome_code' : 'sms.welcome_code',
      dedupeKey: `welcome_code:${issued.id}`,
      payload: { personalCodeId: issued.id },
    });
    return issued.code;
  }

  /**
   * Staff issue a code (`POST /api/admin/customers/:id/codes`). 404 for an unknown customer; 400 `invalid`
   * (`templateId`) unless the promotion is an active template whose end has not passed; 409 `email_not_verified` for
   * `send: 'email'` without a verified e-mail. All checks come before anything is written.
   */
  async issueByStaff(
    customerId: string,
    input: { templateId: number; send: PersonalCodeSend },
    actor: { actorId: number; ip?: string | null },
  ): Promise<IssuedPersonalCode> {
    if (!UUID.test(customerId)) throw notFound();
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      if (!customer) throw notFound();
      const template = await tx.promotion.findUnique({
        where: { id: input.templateId },
        select: { kind: true, active: true, endsAt: true },
      });
      if (
        !template ||
        template.kind !== DbPromotionKind.PERSONAL_TEMPLATE ||
        !template.active ||
        (template.endsAt !== null && template.endsAt <= now)
      )
        throw invalid('templateId');
      if (input.send === 'email' && (!customer.email || !customer.emailVerifiedAt)) throw emailNotVerified();

      const issued = await issuePersonalCode(tx, {
        templateId: input.templateId,
        customerId,
        issuedById: actor.actorId,
        now,
      });
      if (input.send !== 'none')
        await this.outbox.enqueue(tx, {
          type: input.send === 'email' ? 'email.personal_code' : 'sms.personal_code',
          dedupeKey: `personal_code:${issued.id}`,
          payload: { personalCodeId: issued.id },
        });
      await this.audit.record(
        {
          actorId: actor.actorId,
          action: CODE_ISSUED_ACTION,
          entityType: 'customer',
          entityId: customerId,
          after: { templateId: input.templateId },
          ip: actor.ip,
        },
        tx,
      );
      return { code: issued.code, expiresAt: issued.expiresAt.toISOString() };
    });
  }

  /**
   * "ההטבות שלי" (`GET /api/account/benefits`): the account's codes, newest first. The expiry shown is the code's,
   * or the template's end when that is earlier now. Status: `used` once a paid order used it; `expired` past the
   * expiry, when the template is off (that voids unused codes) or — a welcome code — once the account has a paid
   * order; otherwise `active` (also while a live pending order holds it).
   */
  async benefits(customerId: string, now = new Date()): Promise<AccountBenefit[]> {
    const rows = await this.prisma.personalCode.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { promotion: { select: { name: true, kind: true, active: true, isWelcome: true, endsAt: true } } },
    });
    const paid = rows.some((r) => r.promotion.isWelcome && r.orderId === null)
      ? await hasPaidOrder(this.prisma, customerId)
      : false;
    return rows.map((r) => {
      const t = r.promotion;
      const expiresAt = t.endsAt && t.endsAt < r.expiresAt ? t.endsAt : r.expiresAt;
      let status: AccountBenefitStatus = 'active';
      if (r.orderId !== null) status = 'used';
      else if (now > expiresAt || !t.active || t.kind !== DbPromotionKind.PERSONAL_TEMPLATE || (t.isWelcome && paid))
        status = 'expired';
      return { code: r.code, labelHe: t.name, expiresAt: expiresAt.toISOString(), status };
    });
  }
}
