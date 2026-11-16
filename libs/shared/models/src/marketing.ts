/**
 * Marketing consent (Phase 7, CLB-02, ACC-05, decision 95): the current state lives in one contact per e-mail, with an
 * append-only history of every change.
 */

export type MarketingStatus = 'pending' | 'subscribed' | 'unsubscribed';

/** The version of the checkbox text below; every consent event records the version the customer saw. */
export const CONSENT_TEXT_VERSION = '2026-11-16';

/** The marketing checkbox text, in one place (never pre-checked, CLAUDE.md §4.4). */
export const CONSENT_TEXT_HE = 'אני מאשר/ת קבלת דיוור ועדכונים שיווקיים';
