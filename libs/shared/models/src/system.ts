/**
 * The admin "תקלות ומצב המערכת" screen (spec 9b.6, permission `system.view`): error groups and the system status.
 * Dates are ISO strings; byte counts are plain numbers.
 */

export type BackupKindView = 'db' | 'media' | 'restore_test';

export interface BackupRunView {
  kind: BackupKindView;
  startedAt: string;
  /** Null while the run is still going (or died before it could write its end). */
  finishedAt: string | null;
  ok: boolean | null;
  bytes: number | null;
  objects: number | null;
  detail: string | null;
}

/** `GET /api/admin/system/status` */
export interface SystemStatus {
  db: 'up' | 'down';
  /** Null when the server cannot read the disk. */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** Failed outbox jobs; 0 while the database is down. */
  failedJobs: number;
  lastBackup: { db: BackupRunView | null; media: BackupRunView | null };
  lastRestoreTest: BackupRunView | null;
  /** There is a successful DB backup, and no successful restore test in the last 35 days. */
  restoreTestStale: boolean;
  version: string;
  uptimeSeconds: number;
}

export const ERROR_GROUP_STATES = ['open', 'handled', 'all'] as const;
export type ErrorGroupState = (typeof ERROR_GROUP_STATES)[number];

export interface ErrorGroupView {
  id: number;
  kind: 'error' | 'warn';
  source: 'api' | 'ssr';
  message: string;
  path: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  handledAt: string | null;
  reopenedAt: string | null;
}

export interface ErrorGroupDetail extends ErrorGroupView {
  stack: string | null;
  /** The name of who marked it handled; null unless it is handled now. */
  handledBy: string | null;
}

/** `GET /api/admin/system/errors?state=open|handled|all&page=` — 20 per page, newest `lastSeen` first. */
export interface ErrorGroupPage {
  items: ErrorGroupView[];
  total: number;
  page: number;
  pageSize: number;
}

export const ERROR_GROUPS_PAGE_SIZE = 20;
