import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  ORDER_LOOKUP_MISS_HE,
  SUPPORT_FIELD_MESSAGES_HE,
  SUPPORT_NOT_DELIVERED_HE,
  SUPPORT_RETURN_WINDOW_PASSED_HE,
  type ContactRequestBody,
  type OrderView,
  type ReturnRequestBody,
  type SupportErrorCode,
  type SupportField,
  type SupportOrderRef,
  type SupportTicketCreated,
} from '@hg/models';
import { AccountApi } from '../account/account.api';
import { CheckoutApi, checkoutErrorMessage } from '../checkout/checkout.api';

/** "קיבלנו את פנייתך. מספר הפנייה: 5001". */
export const supportSuccessText = (ticketNumber: number): string => `קיבלנו את פנייתך. מספר הפנייה: ${ticketNumber}`;

/** A return form's own wording of 409 `not_delivered` (the damaged form uses the API's). */
export const RETURN_NOT_DELIVERED_HE = 'אפשר לבקש החזרה רק אחרי שההזמנה סופקה';

export type SupportKind = 'return' | 'damaged' | 'contact';

export interface SupportFailure {
  status: number;
  code: SupportErrorCode | 'too_many_requests' | null;
  /** The field an `invalid_field` names (`items.0.quantity` for a line). */
  field: string | null;
  messageHe: string | null;
}

export function supportFailure(error: unknown): SupportFailure {
  if (!(error instanceof HttpErrorResponse)) return { status: 0, code: null, field: null, messageHe: null };
  const body = (typeof error.error === 'object' && error.error !== null ? error.error : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    status: error.status,
    code: text(body['code']) as SupportFailure['code'],
    field: text(body['field']),
    messageHe: text(body['messageHe']),
  };
}

/** Hebrew for a refused submission: the message goes beside the form (or its field when `field` is set). */
export function supportErrorMessage(failure: SupportFailure, kind: SupportKind): string {
  switch (failure.code) {
    case 'invalid_field': {
      const key = (failure.field ?? '').split('.')[0] as SupportField;
      return failure.messageHe ?? SUPPORT_FIELD_MESSAGES_HE[key] ?? checkoutErrorMessage('invalid_input');
    }
    case 'not_found':
      return ORDER_LOOKUP_MISS_HE;
    case 'not_delivered':
      return kind === 'return' ? RETURN_NOT_DELIVERED_HE : SUPPORT_NOT_DELIVERED_HE;
    case 'return_window_passed':
      return SUPPORT_RETURN_WINDOW_PASSED_HE;
    case 'too_many_requests':
      return checkoutErrorMessage('too_many_requests');
    default:
      return failure.status === 429 ? checkoutErrorMessage('too_many_requests') : checkoutErrorMessage(null);
  }
}

/** What the order step hands the form: the order, and the reference the support API wants (null when signed in). */
export interface SupportOrder {
  order: OrderView;
  ref: SupportOrderRef | null;
}

/** The support API (spec §7.1). Same-origin, so the `hg_customer` cookie goes along. Only called in the browser. */
@Injectable({ providedIn: 'root' })
export class SupportApi {
  private readonly http = inject(HttpClient);
  private readonly checkout = inject(CheckoutApi);
  private readonly account = inject(AccountApi);

  /**
   * Signed out: number + phone → the order link → the order. The link's token lives only in this call (never in the
   * URL or in storage). Signed in: the account's own order. A miss is one 404 (`not_found`).
   */
  async loadOrder(number: string, phone: string | null): Promise<SupportOrder> {
    if (phone === null) return { order: await this.account.order(number), ref: null };
    const { url } = await this.checkout.lookupOrder({ number, phone });
    const link = new URL(url, 'http://localhost');
    const token = link.searchParams.get('t') ?? '';
    const order = await this.checkout.order(String(link.pathname.split('/').pop()), token);
    return { order, ref: { number: String(order.number), phone } };
  }

  returns(body: ReturnRequestBody) {
    return firstValueFrom(this.http.post<SupportTicketCreated>('/api/support/returns', body));
  }

  /** Multipart: the fields as the API reads them, and the photos as repeated `photos` files. */
  damaged(
    fields: { order: SupportOrderRef | null; orderItemId: number; description: string; website: string },
    photos: File[],
  ) {
    const form = new FormData();
    if (fields.order) {
      form.append('order[number]', fields.order.number);
      form.append('order[phone]', fields.order.phone);
    }
    form.append('orderItemId', String(fields.orderItemId));
    form.append('description', fields.description);
    form.append('website', fields.website);
    for (const photo of photos) form.append('photos', photo, photo.name);
    return firstValueFrom(this.http.post<SupportTicketCreated>('/api/support/damaged', form));
  }

  contact(body: ContactRequestBody) {
    return firstValueFrom(this.http.post<SupportTicketCreated>('/api/support/contact', body));
  }
}
