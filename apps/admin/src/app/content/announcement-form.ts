import type { AdminAnnouncement, AdminAnnouncementInput } from '@hg/models';
import { CONTENT_LIMITS } from '@hg/models';
import { endFields, israelEndToUtc, israelStartToUtc, startFields } from '../core/israel-time';

export interface AnnouncementForm {
  textHe: string;
  linkUrl: string;
  linkLabelHe: string;
  active: boolean;
  sortOrder: string;
  startDate: string;
  endDate: string;
  /** Kept as stored, so a time set elsewhere is not lost; the form only edits whole Israel days. */
  startTime: string;
  endTime: string;
}

export type AnnouncementField = 'textHe' | 'linkUrl' | 'linkLabelHe' | 'sortOrder' | 'startDate' | 'endDate';
export type AnnouncementErrors = Partial<Record<AnnouncementField, string>>;

export const ANNOUNCEMENT_MESSAGES = {
  text: `יש למלא את טקסט ההודעה (עד ${CONTENT_LIMITS.announcementText} תווים).`,
  linkLabel: 'יש להוסיף קישור לטקסט הקישור, או למחוק את טקסט הקישור.',
  sortOrder: 'הסדר חייב להיות מספר שלם, 0 ומעלה.',
  dateRange: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה.',
} as const;

export function emptyAnnouncementForm(): AnnouncementForm {
  return {
    textHe: '',
    linkUrl: '',
    linkLabelHe: '',
    active: true,
    sortOrder: '0',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
  };
}

export function toAnnouncementForm(a: AdminAnnouncement): AnnouncementForm {
  const start = startFields(a.startsAt);
  const end = endFields(a.endsAt);
  return {
    textHe: a.textHe,
    linkUrl: a.linkUrl ?? '',
    linkLabelHe: a.linkLabelHe ?? '',
    active: a.active,
    sortOrder: String(a.sortOrder),
    startDate: start.date,
    endDate: end.date,
    startTime: start.time,
    endTime: end.time,
  };
}

/** The API input, or the errors that stop it. Links are checked again by the API. */
export function announcementInput(f: AnnouncementForm): {
  input: AdminAnnouncementInput | null;
  errors: AnnouncementErrors;
} {
  const errors: AnnouncementErrors = {};
  const text = f.textHe.trim();
  if (!text || text.length > CONTENT_LIMITS.announcementText) errors.textHe = ANNOUNCEMENT_MESSAGES.text;
  const url = f.linkUrl.trim();
  const label = f.linkLabelHe.trim();
  if (label && !url) errors.linkLabelHe = ANNOUNCEMENT_MESSAGES.linkLabel;
  const sort = f.sortOrder.trim();
  if (!/^\d{1,6}$/.test(sort)) errors.sortOrder = ANNOUNCEMENT_MESSAGES.sortOrder;
  const startsAt = f.startDate ? israelStartToUtc(f.startDate, f.startTime) : null;
  const endsAt = f.endDate ? israelEndToUtc(f.endDate, f.endTime) : null;
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt))
    errors.endDate = ANNOUNCEMENT_MESSAGES.dateRange;
  if (Object.keys(errors).length) return { input: null, errors };
  return {
    input: {
      textHe: text,
      linkUrl: url || null,
      linkLabelHe: label || null,
      active: f.active,
      sortOrder: Number(sort),
      startsAt,
      endsAt,
    },
    errors,
  };
}
