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
/** The attention note never grows past this many characters; the customer's part is cut to fit. */
const ATTENTION_NOTE_MAX = 500;

/**
 * The delivery confirmation link (spec §5.3, SHP-04). The token in the URL is the only key; only its SHA-256 is
 * stored. An unknown token, a superseded slot and a cancelled order all answer 404; the view also once the order
 * moved past DELIVERY_SCHEDULED, an answer then 409 `slot_closed`.
 */
@Injectable()
export class DeliverySlotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 404 also once the order moved past DELIVERY_SCHEDULED (shipped, delivered): the link has done its job. */
  async view(token: string): Promise<DeliveryLinkView> {
    const slot = await this.find(this.prisma, token);
    if (slot.order.status !== OrderStatus.DELIVERY_SCHEDULED) throw orderNotFound();
    return toView(slot);
  }

  /**
   * Records the answer under the order lock (a staff slot change cannot interleave). A slot answers once, and only
   * while the order is DELIVERY_SCHEDULED (409 `slot_closed` otherwise).
   */
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
      if (slot.order.status !== OrderStatus.DELIVERY_SCHEDULED)
        throw new CheckoutError(HttpStatus.CONFLICT, 'slot_closed');
      if (slot.state !== DeliverySlotState.PROPOSED) throw new CheckoutError(HttpStatus.CONFLICT, 'already_answered');
      const state = answer === 'confirm' ? DeliverySlotState.CONFIRMED : DeliverySlotState.CHANGE_REQUESTED;
      await tx.deliverySlot.update({
        where: { id: slot.id },
        data: { state, respondedAt: new Date(), ...(note ? { note } : {}) },
      });
      if (answer === 'change') {
        const current = await tx.order.findUniqueOrThrow({
          where: { id: slot.orderId },
          select: { attentionNote: true },
        });
        await tx.order.update({
          where: { id: slot.orderId },
          data: { needsAttention: true, attentionNote: changeNote(current.attentionNote, note) },
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

/**
 * The attention note after a change request: an earlier, different note stays (the new text follows after " · ");
 * the customer's own words follow " — " and are cut so the whole note stays within `ATTENTION_NOTE_MAX`.
 */
export function changeNote(existing: string | null, customerNote: string): string {
  const prefix = existing && existing !== DELIVERY_CHANGE_NOTE ? `${existing} · ` : '';
  const room = ATTENTION_NOTE_MAX - prefix.length - DELIVERY_CHANGE_NOTE.length - 3;
  if (!customerNote || room < 2) return `${prefix}${DELIVERY_CHANGE_NOTE}`.slice(0, ATTENTION_NOTE_MAX);
  const shown = customerNote.length > room ? `${customerNote.slice(0, room - 1)}…` : customerNote;
  return `${prefix}${DELIVERY_CHANGE_NOTE} — ${shown}`;
}
