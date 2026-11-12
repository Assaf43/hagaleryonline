import { BRAND } from '@hg/models';

export interface DeliverySlotSmsData {
  number: number;
  /** Display date, e.g. 15.12.2026. */
  date: string;
  from: string;
  to: string;
  /** Absolute link to /delivery/{token}. */
  url: string;
}

export const deliverySlotSms = (d: DeliverySlotSmsData): string =>
  `${BRAND.name}: האספקה של הזמנה ${d.number} מתואמת ל־${d.date} בין ${d.from} ל־${d.to}. לאישור או לשינוי: ${d.url}`;
