import { deliverySlotSms, type DeliverySlotSmsData } from './sms.js';
import {
  orderCancelled,
  orderPaid,
  refund,
  statusDelivered,
  statusShipped,
  type OrderLinkData,
  type OrderPaidData,
  type RefundData,
} from './order-messages.js';
import { otpEmail, otpText, type OtpData } from './otp.js';
import type { RenderedEmail } from './layout.js';

export type { RenderedEmail } from './layout.js';
export type { OrderLinkData, OrderPaidData, OrderPaidLine, RefundData } from './order-messages.js';
export type { OtpData } from './otp.js';
export type { DeliverySlotSmsData } from './sms.js';

/** The data each e-mail template needs. All Hebrew strings live in this folder (GEN-04). */
export interface EmailTemplateData {
  order_paid: OrderPaidData;
  status_shipped: OrderLinkData;
  status_delivered: OrderLinkData;
  order_cancelled: OrderLinkData;
  refund: RefundData;
  otp: OtpData;
}
export type EmailTemplate = keyof EmailTemplateData;

export interface SmsTemplateData {
  delivery_slot: DeliverySlotSmsData;
  otp: OtpData;
}
export type SmsTemplate = keyof SmsTemplateData;

const EMAIL: { [T in EmailTemplate]: (data: EmailTemplateData[T]) => RenderedEmail } = {
  order_paid: orderPaid,
  status_shipped: statusShipped,
  status_delivered: statusDelivered,
  order_cancelled: orderCancelled,
  refund,
  otp: otpEmail,
};

const SMS: { [T in SmsTemplate]: (data: SmsTemplateData[T]) => string } = {
  delivery_slot: deliverySlotSms,
  otp: otpText,
};

export function renderEmail<T extends EmailTemplate>(template: T, data: EmailTemplateData[T]): RenderedEmail {
  return (EMAIL[template] as (d: EmailTemplateData[T]) => RenderedEmail)(data);
}

export function renderSms<T extends SmsTemplate>(template: T, data: SmsTemplateData[T]): string {
  return (SMS[template] as (d: SmsTemplateData[T]) => string)(data);
}
