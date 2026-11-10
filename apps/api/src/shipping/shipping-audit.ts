import type { AdminShippingRate, AdminShippingSettings, AdminShippingZone } from '@hg/models';

/**
 * What the audit log keeps of shipping changes (ADM-11): flat, Hebrew-keyed, readable values, so the admin's
 * audit page can show them as they are ("ספות: הובלה ₪450 / הרכבה ₪200").
 */
export type AuditView = Record<string, string>;

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** 45000 agorot → "₪450". */
export const shekels = (agorot: number) => `₪${NUMBER.format(agorot / 100)}`;

/** One key per row (the category's Hebrew name, made unique if two share it), then the settings. */
export function ratesAuditView(rates: AdminShippingRate[], settings: AdminShippingSettings): AuditView {
  const view: AuditView = {};
  for (const r of rates) {
    const key = r.categoryNameHe in view ? `${r.categoryNameHe} (#${r.categoryId})` : r.categoryNameHe;
    view[key] =
      r.deliveryPrice === null || r.assemblyPrice === null
        ? 'ללא מחיר משלו'
        : `הובלה ${shekels(r.deliveryPrice)} / הרכבה ${shekels(r.assemblyPrice)}`;
  }
  view['הנחה לפריט נוסף'] = `${settings.additionalItemPercent}%`;
  view['תוספת לקומה'] = shekels(settings.floorSurcharge);
  view['מקומה'] = String(settings.floorSurchargeFrom);
  return view;
}

export function zoneAuditView(zone: AdminShippingZone): AuditView {
  return {
    שם: zone.name,
    תוספת: shekels(zone.surcharge),
    יישובים: zone.localities.map((l) => l.nameHe).join(', ') || 'ללא יישובים',
  };
}

/** Only the keys whose value changed; null when nothing did. */
export function auditDiff(before: AuditView, after: AuditView): { before: AuditView; after: AuditView } | null {
  const b: AuditView = {};
  const a: AuditView = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (key in before) b[key] = before[key];
    if (key in after) a[key] = after[key];
  }
  return Object.keys(a).length || Object.keys(b).length ? { before: b, after: a } : null;
}
