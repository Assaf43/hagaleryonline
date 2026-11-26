import { BRAND } from '@hg/models';
import { bdi, button, emailLayout, esc, paragraph, type RenderedEmail } from './layout.js';

export type SystemAlertReason = 'new_error' | 'reopened_error' | 'backup_failed' | 'backup_missing' | 'error_storm';

export interface SystemAlertData {
  reason: SystemAlertReason;
  /** Scrubbed message or the backup kind. Escaped here; never carries a customer's details or a query string. */
  summary: string;
  /** Israel time, `dd.mm.yyyy hh:mm`. */
  at: string;
  /** The admin system screen, `${ADMIN_URL}/system`. */
  link: string;
}

const SUBJECT: Record<SystemAlertReason, string> = {
  new_error: 'תקלה חדשה במערכת',
  reopened_error: 'תקלה חזרה',
  backup_failed: 'הגיבוי נכשל',
  backup_missing: 'לא בוצע גיבוי ב-26 השעות האחרונות',
  error_storm: 'תקלות רבות במערכת',
};

const WHAT: Record<SystemAlertReason, string> = {
  new_error: 'נרשמה תקלה חדשה במערכת.',
  reopened_error: 'תקלה שסומנה כמטופלת חזרה.',
  backup_failed: 'גיבוי נכשל.',
  backup_missing: 'לא בוצע גיבוי מוצלח של מסד הנתונים ב-26 השעות האחרונות.',
  error_storm: 'נרשמו תקלות רבות במערכת בזמן קצר.',
};

const SEE_SYSTEM = 'לפרטים במסך המערכת';
/** For a storm the summary is the number of new error groups that were not sent separately. */
const stormLine = (count: string): string => `ועוד ${count} תקלות חדשות לא נשלחו בנפרד.`;
const WHEN = 'זמן';

/** To the business inbox (`ALERT_EMAIL`): what happened, the scrubbed summary, when, and a link to the admin. */
export function systemAlert(d: SystemAlertData): RenderedEmail {
  const subject = `${BRAND.name}: ${SUBJECT[d.reason]}`;
  const html = emailLayout(
    subject,
    [
      paragraph(esc(WHAT[d.reason])),
      paragraph(d.reason === 'error_storm' ? esc(stormLine(d.summary)) : bdi(d.summary)),
      paragraph(`${esc(WHEN)}: ${bdi(d.at)}`),
      button(d.link, SEE_SYSTEM),
    ].join('\n'),
  );
  const text = [
    WHAT[d.reason],
    '',
    d.reason === 'error_storm' ? stormLine(d.summary) : d.summary,
    '',
    `${WHEN}: ${d.at}`,
    '',
    `${SEE_SYSTEM}: ${d.link}`,
  ].join('\n');
  return { subject, html, text };
}
