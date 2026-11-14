import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  RETURN_REASONS,
  RETURN_WINDOW_LIMITS,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_TYPES,
  TICKET_NOTE_LIMITS,
  type AdminTicketDetail,
  type AdminTicketItem,
  type AdminTicketNewCount,
  type AdminTicketPage,
  type ReturnReason,
  type StoreSettingsView,
  type SupportTicketStatus as StatusView,
  type SupportTicketType as TypeView,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { SupportTicketStatus, SupportTicketType, type Prisma } from '../generated/prisma/client.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_RETURN_WINDOW_DAYS } from './support.service.js';

export const ADMIN_TICKETS_PAGE_SIZE = 30;
/** `support_tickets.number` is a PostgreSQL integer (int4). */
const MAX_TICKET_NUMBER = 2_147_483_647;
/** `ticket_attachments.id` is a PostgreSQL integer too. */
const MAX_ATTACHMENT_ID = 2_147_483_647;
/** What a stored photo may be served as; anything else is sent as a download of unknown type. */
const SERVED_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

const TYPE_VIEW: Record<SupportTicketType, TypeView> = {
  RETURN: 'return',
  EXCHANGE: 'exchange',
  DAMAGED: 'damaged',
  CONTACT: 'contact',
  DELIVERY_CHANGE: 'delivery_change',
};
const TYPE_DB = Object.fromEntries(Object.entries(TYPE_VIEW).map(([db, view]) => [view, db])) as Record<
  TypeView,
  SupportTicketType
>;
const STATUS_VIEW: Record<SupportTicketStatus, StatusView> = {
  NEW: 'new',
  IN_PROGRESS: 'in_progress',
  CLOSED: 'closed',
};
const STATUS_DB = Object.fromEntries(Object.entries(STATUS_VIEW).map(([db, view]) => [view, db])) as Record<
  StatusView,
  SupportTicketStatus
>;

export const invalidInput = (field: string) =>
  new BadRequestException({ statusCode: 400, code: 'invalid_input', field });
const notFound = () => new NotFoundException({ statusCode: HttpStatus.NOT_FOUND, code: 'not_found' });

/** Who made an admin change (audit). */
export interface AdminActor {
  actorId: number;
  ip?: string | null;
}

export interface TicketFilter {
  type?: TypeView;
  status?: StatusView;
  page: number;
}

/** The query of the list: `type` and `status` from the models' lists (empty = all), `page` from 1. */
export function parseTicketFilter(query: { type?: unknown; status?: unknown; page?: unknown }): TicketFilter {
  const pick = <T extends string>(value: unknown, list: readonly T[], field: string): T | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) throw invalidInput(field);
    return value as T;
  };
  let page = 1;
  if (query.page !== undefined && query.page !== '') {
    if (typeof query.page !== 'string' || !/^\d{1,6}$/.test(query.page) || Number(query.page) < 1)
      throw invalidInput('page');
    page = Number(query.page);
  }
  return {
    type: pick(query.type, SUPPORT_TICKET_TYPES, 'type'),
    status: pick(query.status, SUPPORT_TICKET_STATUSES, 'status'),
    page,
  };
}

/** A ticket number of a URL segment (digits, int4), or null: the endpoint's normal 404. */
export function parseTicketNumber(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= MAX_TICKET_NUMBER ? n : null;
}

/** An attachment id of a URL segment (digits, int4), or null. */
export function parseAttachmentId(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= MAX_ATTACHMENT_ID ? n : null;
}

/** `{ status }` of a status change. */
export function parseStatusInput(body: unknown): StatusView {
  const status = (typeof body === 'object' && body !== null ? body : {}) as { status?: unknown };
  if (typeof status.status !== 'string' || !(SUPPORT_TICKET_STATUSES as readonly string[]).includes(status.status))
    throw invalidInput('status');
  return status.status as StatusView;
}

/** `{ body }` of a note: trimmed, 1–2000 characters. */
export function parseNoteInput(body: unknown): string {
  const note = (typeof body === 'object' && body !== null ? body : {}) as { body?: unknown };
  if (typeof note.body !== 'string') throw invalidInput('body');
  const text = note.body.trim();
  if (text.length < TICKET_NOTE_LIMITS.min || text.length > TICKET_NOTE_LIMITS.max) throw invalidInput('body');
  return text;
}

/** `{ returnWindowDays }`: a whole number of days, 1–60. */
export function parseStoreSettingsInput(body: unknown): StoreSettingsView {
  const input = (typeof body === 'object' && body !== null ? body : {}) as { returnWindowDays?: unknown };
  const days = input.returnWindowDays;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < RETURN_WINDOW_LIMITS.min ||
    days > RETURN_WINDOW_LIMITS.max
  )
    throw invalidInput('returnWindowDays');
  return { returnWindowDays: days };
}

/** The stored `items` JSON: `[{ orderItemId, quantity? }]`; anything else is skipped. */
function ticketLines(items: Prisma.JsonValue | null): { orderItemId: number; quantity: number | null }[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const item = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    if (typeof item.orderItemId !== 'number') return [];
    return [{ orderItemId: item.orderItemId, quantity: typeof item.quantity === 'number' ? item.quantity : null }];
  });
}

const detailInclude = {
  order: {
    select: {
      number: true,
      items: { select: { id: true, sku: true, modelName: true, nameHe: true, optionLabels: true, quantity: true } },
    },
  },
  attachments: { select: { id: true, mimeType: true, size: true }, orderBy: { id: 'asc' } },
  notes: {
    select: { id: true, body: true, createdAt: true, author: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.SupportTicketInclude;
type TicketWithDetail = Prisma.SupportTicketGetPayload<{ include: typeof detailInclude }>;

function detailView(t: TicketWithDetail): AdminTicketDetail {
  const orderLines = new Map((t.order?.items ?? []).map((i) => [i.id, i]));
  const items: AdminTicketItem[] = ticketLines(t.items).map(({ orderItemId, quantity }) => {
    const line = orderLines.get(orderItemId);
    return {
      orderItemId,
      quantity,
      sku: line?.sku ?? null,
      modelName: line?.modelName ?? null,
      nameHe: line?.nameHe ?? null,
      optionLabels: Array.isArray(line?.optionLabels) ? (line.optionLabels as string[]) : [],
      orderedQuantity: line?.quantity ?? null,
    };
  });
  return {
    number: t.number,
    type: TYPE_VIEW[t.type],
    status: STATUS_VIEW[t.status],
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    contact: { fullName: t.fullName, phone: t.phone, email: t.email },
    subject: t.subject,
    message: t.message,
    reasonCode:
      t.reasonCode && (RETURN_REASONS as readonly string[]).includes(t.reasonCode)
        ? (t.reasonCode as ReturnReason)
        : null,
    orderNumber: t.order?.number ?? null,
    hasAccount: t.customerId !== null,
    items,
    attachments: t.attachments,
    notes: t.notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt.toISOString(), author: n.author })),
  };
}

/** A stored photo to stream to staff. */
export interface TicketPhoto {
  content: Buffer;
  contentType: string;
}

/**
 * The admin support inbox (spec §7.2, permission `support.manage`): the list, the "new" counter, the ticket page,
 * internal notes and status changes (both audited), and the private photos. Replies happen outside the system and
 * money goes through the order's refund action: nothing here touches the order.
 */
@Injectable()
export class SupportAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageProvider,
  ) {}

  async list(filter: TicketFilter): Promise<AdminTicketPage> {
    const where: Prisma.SupportTicketWhereInput = {
      ...(filter.type ? { type: TYPE_DB[filter.type] } : {}),
      ...(filter.status ? { status: STATUS_DB[filter.status] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (filter.page - 1) * ADMIN_TICKETS_PAGE_SIZE,
        take: ADMIN_TICKETS_PAGE_SIZE,
        include: { order: { select: { number: true } }, _count: { select: { attachments: true } } },
      }),
    ]);
    return {
      items: rows.map((t) => ({
        number: t.number,
        type: TYPE_VIEW[t.type],
        status: STATUS_VIEW[t.status],
        createdAt: t.createdAt.toISOString(),
        fullName: t.fullName,
        phone: t.phone,
        subject: t.subject,
        orderNumber: t.order?.number ?? null,
        attachmentCount: t._count.attachments,
      })),
      total,
      page: filter.page,
      pageSize: ADMIN_TICKETS_PAGE_SIZE,
    };
  }

  async countNew(): Promise<AdminTicketNewCount> {
    return { count: await this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.NEW } }) };
  }

  async detail(numberParam: string): Promise<AdminTicketDetail> {
    const number = parseTicketNumber(numberParam);
    if (number === null) throw notFound();
    const ticket = await this.prisma.supportTicket.findUnique({ where: { number }, include: detailInclude });
    if (!ticket) throw notFound();
    return detailView(ticket);
  }

  /** Any status to any other (a closed ticket can be reopened); the same status again changes nothing. */
  async setStatus(numberParam: string, status: StatusView, actor: AdminActor): Promise<AdminTicketDetail> {
    const number = parseTicketNumber(numberParam);
    if (number === null) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      // Locks the row so two parallel changes are audited in the order they happened. The enum's database value is
      // the models' name ('new', 'in_progress', 'closed').
      const rows = await tx.$queryRaw<{ status: StatusView }[]>`
        SELECT status::text AS status FROM support_tickets WHERE number = ${number} FOR UPDATE`;
      if (rows.length === 0) throw notFound();
      const before = rows[0].status;
      if (before === status) return;
      await tx.supportTicket.update({ where: { number }, data: { status: STATUS_DB[status] } });
      await this.audit.record(
        {
          ...actor,
          action: 'support.status',
          entityType: 'support_ticket',
          entityId: number,
          before: { status: before },
          after: { status },
        },
        tx,
      );
    });
    return this.detail(numberParam);
  }

  /** An internal note by the signed-in staff member. The audit entry names the note, not its text. */
  async addNote(numberParam: string, body: string, actor: AdminActor): Promise<AdminTicketDetail> {
    const number = parseTicketNumber(numberParam);
    if (number === null) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { number }, select: { id: true } });
      if (!ticket) throw notFound();
      const note = await tx.ticketNote.create({
        data: { ticketId: ticket.id, adminUserId: actor.actorId, body },
        select: { id: true },
      });
      await this.audit.record(
        {
          ...actor,
          action: 'support.note',
          entityType: 'support_ticket',
          entityId: number,
          after: { noteId: note.id, length: body.length },
        },
        tx,
      );
    });
    return this.detail(numberParam);
  }

  /**
   * A photo of this ticket from private storage. The attachment must belong to the ticket of the URL, and its key
   * must sit in that ticket's own folder; anything else (or a missing file) is the same 404.
   */
  async photo(numberParam: string, idParam: string): Promise<TicketPhoto> {
    const number = parseTicketNumber(numberParam);
    const id = parseAttachmentId(idParam);
    if (number === null || id === null) throw notFound();
    const attachment = await this.prisma.ticketAttachment.findFirst({
      where: { id, ticket: { number } },
      select: { storageKey: true, mimeType: true, ticketId: true },
    });
    if (!attachment) throw notFound();
    const folder = `support/${attachment.ticketId}/`;
    const name = attachment.storageKey.slice(folder.length);
    if (!attachment.storageKey.startsWith(folder) || !/^[\w-]+\.\w+$/.test(name)) throw notFound();
    const content = await this.storage.read(attachment.storageKey, 'private');
    if (!content) throw notFound();
    return {
      content,
      contentType: SERVED_TYPES.has(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream',
    };
  }

  async storeSettings(): Promise<StoreSettingsView> {
    const row = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    return { returnWindowDays: row?.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS };
  }

  async saveStoreSettings(input: StoreSettingsView, actor: AdminActor): Promise<StoreSettingsView> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ return_window_days: number }[]>`
        SELECT return_window_days FROM store_settings WHERE id = 1 FOR UPDATE`;
      const before = rows[0]?.return_window_days ?? null;
      const row = await tx.storeSettings.upsert({
        where: { id: 1 },
        create: { id: 1, returnWindowDays: input.returnWindowDays },
        update: { returnWindowDays: input.returnWindowDays },
      });
      if (before !== row.returnWindowDays)
        await this.audit.record(
          {
            ...actor,
            action: 'settings.store',
            entityType: 'store_settings',
            entityId: 1,
            before: before === null ? null : { returnWindowDays: before },
            after: { returnWindowDays: row.returnWindowDays },
          },
          tx,
        );
      return { returnWindowDays: row.returnWindowDays };
    });
  }
}
