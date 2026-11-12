import { HttpStatus, Injectable } from '@nestjs/common';
import type { DeliveryAnswerRequest, DeliveryLinkView } from '@hg/models';
import { hashToken } from '../auth/crypto.js';
import { AuditService } from '../audit/audit.service.js';
import { DeliverySlotState, OrderStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockOrder } from './locks.js';
import { badField, CheckoutError, orderNotFound } from './order-errors.js';
import { SLOT_NOTE_MAX, slotStateView } from './delivery-slot.js';

/** The attention note of a change request; the customer's own words follow after " — ". */
export const DELIVERY_CHANGE_NOTE = 'הלקוח ביקש מועד אספקה אחר';
/** The customer's note is cut to this many characters inside the attention note (the column stays small). */
const ATTENTION_NOTE_MAX = 300;

/**
 * The delivery confirmation link (spec §5.3, SHP-04). The token in the URL is the only key; only its SHA-256 is
 * stored. An unknown token, a superseded slot and a cancelled order all answer 404.
 */
@Injectable()
export class DeliverySlotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(token: string): Promise<DeliveryLinkView> {
    return toView(await this.find(this.prisma, token));
  }

  /** Records the answer under the order lock (a staff slot change cannot interleave). A slot answers once. */
  async answer(token: string, raw: unknown, ip?: string): Promise<DeliveryLinkView> {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
      Record<keyof DeliveryAnswerRequest, unknown>
    >;
    if (body.answer !== 'confirm' && body.answer !== 'change') throw badField('answer');
    if (
      body.note !== undefined &&
      body.note !== null &&
      (typeof body.note !== 'string' || body.note.length > SLOT_NOTE_MAX)
    )
      throw badField('note');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const answer = body.answer;

    const first = await this.find(this.prisma, token);
    return this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, first.orderId);
      // Read again under the lock: staff may have replaced the slot or cancelled the order meanwhile.
      const slot = await this.find(tx, token);
      if (slot.state !== DeliverySlotState.PROPOSED) throw new CheckoutError(HttpStatus.CONFLICT, 'already_answered');
      const state = answer === 'confirm' ? DeliverySlotState.CONFIRMED : DeliverySlotState.CHANGE_REQUESTED;
      await tx.deliverySlot.update({
        where: { id: slot.id },
        data: { state, respondedAt: new Date(), ...(note ? { note } : {}) },
      });
      if (answer === 'change') {
        const shown = note.length > ATTENTION_NOTE_MAX ? `${note.slice(0, ATTENTION_NOTE_MAX)}…` : note;
        await tx.order.update({
          where: { id: slot.orderId },
          data: {
            needsAttention: true,
            attentionNote: shown ? `${DELIVERY_CHANGE_NOTE} — ${shown}` : DELIVERY_CHANGE_NOTE,
          },
        });
      }
      await this.audit.record(
        {
          actorId: null,
          action: answer === 'confirm' ? 'delivery.confirmed' : 'delivery.change_requested',
          entityType: 'order',
          entityId: slot.order.number,
          before: { slot: slotStateView(slot.state) },
          after: { slot: slotStateView(state), ...(note ? { note } : {}) },
          ip,
        },
        tx,
      );
      return toView({ ...slot, state });
    });
  }

  private async find(db: Pick<PrismaService, 'deliverySlot'>, token: string) {
    const slot = token
      ? await db.deliverySlot.findUnique({
          where: { tokenHash: hashToken(token) },
          include: { order: { select: { number: true, status: true } } },
        })
      : null;
    if (!slot || slot.state === DeliverySlotState.SUPERSEDED || slot.order.status === OrderStatus.CANCELLED)
      throw orderNotFound();
    return slot;
  }
}

function toView(slot: {
  date: Date;
  windowFrom: string;
  windowTo: string;
  state: DeliverySlotState;
  order: { number: number };
}): DeliveryLinkView {
  return {
    orderNumber: slot.order.number,
    date: slot.date.toISOString().slice(0, 10),
    windowFrom: slot.windowFrom,
    windowTo: slot.windowTo,
    state: slotStateView(slot.state),
  };
}
